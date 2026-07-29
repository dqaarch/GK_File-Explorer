"""
EWA -> PLY batch exporter.

Usage:
    python ewa_export_sequence.py <input.ewa> <output_dir> <base_name>

Decodes every frame in the EWA file and writes one .ply per frame into
<output_dir>, named:

    <base_name>_001.ply
    <base_name>_002.ply
    ...

Each frame is written to disk immediately after it is decoded (no batching):
the first PLY appears on disk the moment frame 1 finishes, etc.

Streams progress to stdout on its own line so the Rust host can surface a
progress bar in the UI:

    [progress] K/NF <output_file_name>
"""
import os
import sys
import struct
import numpy as np
import zstandard as zstd
import av
from plyfile import PlyData, PlyElement


DTYPE = np.dtype([
    ('x', np.float32), ('y', np.float32), ('z', np.float32),
    ('nx', np.float32), ('ny', np.float32), ('nz', np.float32),
    ('f_dc_0', np.float32), ('f_dc_1', np.float32), ('f_dc_2', np.float32),
    ('opacity', np.float32),
    ('scale_0', np.float32), ('scale_1', np.float32), ('scale_2', np.float32),
    ('rot_0', np.float32), ('rot_1', np.float32), ('rot_2', np.float32), ('rot_3', np.float32),
])


def _read_vec(buf, o, n):
    return np.array([struct.unpack_from('<f', buf, o + 4 * i)[0] for i in range(n)], dtype=np.float32)


def _st(l):
    return max(0.0, min(1.0, (float(l) - 16.0) / 219.0))


def _lum(s, i, COLS, A, W, Y):
    row = s // COLS
    col = s % COLS
    idx = (row * A + (i // A)) * W + col * A + (i % A)
    return int(Y.flat[idx])


def _lp(v, a, b):
    return v * (float(b) - float(a)) + float(a)


def decode_all_headers(ewa_path):
    """Open the .ewa, parse scalars + meansLo for every frame, then yield one
    ('frame', payload) per decoded video frame. Yields a single ('meta', ...)
    first so the caller can pull range tables once."""
    buf = open(ewa_path, 'rb').read()

    nG = struct.unpack_from('<I', buf, 8)[0]
    NF = struct.unpack_from('<I', buf, 12)[0]
    rangesOff = struct.unpack_from('<I', buf, 32)[0]
    frameIdxOff = struct.unpack_from('<I', buf, 40)[0]
    mlOff = struct.unpack_from('<I', buf, 44)[0]
    vidOff = struct.unpack_from('<I', buf, 48)[0]

    A = struct.unpack_from('<H', buf, 24)[0]
    COLS = buf[26]
    ROWS = buf[27]
    W = A * COLS
    H = A * ROWS

    o = rangesOff
    mMin = _read_vec(buf, o, 3); mMax = _read_vec(buf, o + 12, 3); o += 24
    sMin = _read_vec(buf, o, 3); sMax = _read_vec(buf, o + 12, 3); o += 24
    qMin = _read_vec(buf, o, 4); qMax = _read_vec(buf, o + 16, 4); o += 32
    opMin = struct.unpack_from('<f', buf, o)[0]
    opMax = struct.unpack_from('<f', buf, o + 4)[0]; o += 8
    hMin = _read_vec(buf, o, 3); hMax = _read_vec(buf, o + 12, 3)

    flags = struct.unpack_from('<I', buf, mlOff)[0]

    # meansLo for every frame
    p = mlOff + 4
    los = []
    for f in range(NF):
        sz = struct.unpack_from('<I', buf, p)[0]; p += 4
        zstd_data = buf[p:p + sz]; p += sz
        raw = zstd.ZstdDecompressor().decompress(zstd_data, max_output_size=4 * nG)
        if flags & 0x40000000:
            base = int(raw[0])
            lut = np.frombuffer(raw, dtype=np.uint8, count=base, offset=1)
            pk = np.frombuffer(raw, dtype=np.uint8, count=nG, offset=1 + base)
            b2 = base * base
            ix = pk // b2
            rem = (pk - ix * b2).astype(np.uint8)
            iy = rem // base
            iz = (rem - iy * base).astype(np.uint8)
            lo = np.empty((nG, 3), dtype=np.uint8)
            lo[:, 0] = lut[ix]; lo[:, 1] = lut[iy]; lo[:, 2] = lut[iz]
            los.append(lo)
        else:
            los.append(np.frombuffer(raw, dtype=np.uint8, count=nG * 3).reshape((nG, 3)))

    ranges = {
        'nG': nG, 'NF': NF, 'W': W, 'H': H, 'A': A, 'COLS': COLS,
        'mMin': mMin, 'mMax': mMax,
        'sMin': sMin, 'sMax': sMax,
        'qMin': qMin, 'qMax': qMax,
        'opMin': opMin, 'opMax': opMax,
        'hMin': hMin, 'hMax': hMax,
    }
    yield ('meta', ranges)

    codec_ctx = av.codec.context.CodecContext.create('vp9', 'r')
    for f in range(NF):
        off = struct.unpack_from('<I', buf, frameIdxOff + f * 8)[0]
        szw = struct.unpack_from('<I', buf, frameIdxOff + f * 8 + 4)[0]
        sz = szw & 0x7FFFFFFF
        vp9_data = buf[vidOff + off:vidOff + off + sz]
        packet = av.packet.Packet(bytes(vp9_data))
        decoded_frames = codec_ctx.decode(packet)
        if decoded_frames:
            arr = decoded_frames[0].to_ndarray()
            luma = np.ascontiguousarray(arr[:H, :])
        else:
            luma = np.zeros((H, W), dtype=np.uint8)
        yield ('frame', {'luma': luma, 'lo': los[f]})
    del codec_ctx


def _build_frame(nG, ranges, luma, lo):
    mMin, mMax = ranges['mMin'], ranges['mMax']
    sMin, sMax = ranges['sMin'], ranges['sMax']
    qMin, qMax = ranges['qMin'], ranges['qMax']
    opMin, opMax = ranges['opMin'], ranges['opMax']
    hMin, hMax = ranges['hMin'], ranges['hMax']
    COLS, A, W = ranges['COLS'], ranges['A'], ranges['W']
    HP = np.pi / 2.0

    pos = np.zeros((nG, 3), dtype=np.float32)
    scl = np.zeros((nG, 3), dtype=np.float32)
    rot = np.zeros((nG, 4), dtype=np.float32)
    opa = np.zeros(nG, dtype=np.float32)
    col = np.zeros((nG, 3), dtype=np.float32)

    Y = luma
    for i in range(nG):
        vals = [_st(_lum(s, i, COLS, A, W, Y)) for s in range(14)]
        for k in range(3):
            hi = int(round(vals[k] * 219.0))
            O = hi * 256 + int(lo[i, k])
            n = _lp(float(O) / 56319.0, mMin[k], mMax[k])
            pos[i, k] = float(np.sign(n) * (np.exp(np.abs(n)) - 1))
        for k in range(3):
            scl[i, k] = float(np.exp(_lp(vals[3 + k], sMin[k], sMax[k])))
        q_raw = [float(np.sin(_lp(vals[6 + k], qMin[k], qMax[k]) * HP)) for k in range(4)]
        q_norm = float(np.sqrt(sum(x ** 2 for x in q_raw))) or 1.0
        for k in range(4):
            rot[i, k] = q_raw[k] / q_norm
        opa[i] = float(1.0 / (1.0 + np.exp(-_lp(vals[10], opMin, opMax))))
        Yc = _lp(vals[11], hMin[0], hMax[0])
        Cb_v = _lp(vals[12], hMin[1], hMax[1])
        Cr_v = _lp(vals[13], hMin[2], hMax[2])
        col[i, 0] = float(Yc + 1.402 * Cr_v)
        col[i, 1] = float(Yc - 0.344 * Cb_v - 0.714 * Cr_v)
        col[i, 2] = float(Yc + 1.772 * Cb_v)

    rot[:, :] = -rot[:, :]

    arr = np.empty(nG, dtype=DTYPE)
    arr['x'] = pos[:, 0]; arr['y'] = pos[:, 1]; arr['z'] = pos[:, 2]
    arr['nx'] = 0.0; arr['ny'] = 0.0; arr['nz'] = 0.0
    arr['f_dc_0'] = col[:, 0]; arr['f_dc_1'] = col[:, 1]; arr['f_dc_2'] = col[:, 2]
    arr['opacity'] = np.log(np.clip(opa, 1e-6, 1 - 1e-6) / (1 - np.clip(opa, 1e-6, 1 - 1e-6)))
    scl_clamped = np.clip(scl, 1e-6, None)
    arr['scale_0'] = np.log(scl_clamped[:, 0])
    arr['scale_1'] = np.log(scl_clamped[:, 1])
    arr['scale_2'] = np.log(scl_clamped[:, 2])
    arr['rot_0'] = rot[:, 0]; arr['rot_1'] = rot[:, 1]
    arr['rot_2'] = rot[:, 2]; arr['rot_3'] = rot[:, 3]
    return arr


def write_ply(arr, out_path):
    el = PlyElement.describe(arr, 'vertex')
    PlyData([el]).write(out_path)


def main():
    if len(sys.argv) < 4:
        print('Usage: python ewa_export_sequence.py <input.ewa> <output_dir> <base_name>', flush=True)
        sys.exit(1)

    ewa_path = sys.argv[1]
    output_dir = sys.argv[2]
    base_name = sys.argv[3]

    os.makedirs(output_dir, exist_ok=True)
    print(f'[export] Decoding {ewa_path}...', flush=True)

    it = decode_all_headers(ewa_path)
    kind, ranges = next(it)
    if kind != 'meta':
        print('[export] internal error: first yield is not meta', flush=True)
        sys.exit(1)
    nG, NF = ranges['nG'], ranges['NF']
    print(f'[export] nG={nG} NF={NF}', flush=True)
    # Emit a 0/total line so the UI bar can paint its total width even before
    # the first PLY has been written (meansLo + codec warm-up can take seconds).
    print(f'[progress] 0/{NF} ', flush=True)

    pad = max(3, len(str(NF)))

    written = 0
    for kind, payload in it:
        if kind != 'frame':
            continue
        arr = _build_frame(nG, ranges, payload['luma'], payload['lo'])
        written += 1
        idx = written
        out_name = f'{base_name}_{idx:0{pad}d}.ply'
        out_path = os.path.join(output_dir, out_name)
        write_ply(arr, out_path)
        # Flush so the file is visible on disk and the host captures a fresh
        # progress line as soon as this frame is fully written.
        print(f'[progress] {idx}/{NF} {out_name}', flush=True)

    print(f'[export] Done. Wrote {NF} PLY files to {output_dir}', flush=True)


if __name__ == '__main__':
    main()
