import PyOpenColorIO as OCIO
import os
import numpy as np

os.environ['OCIO'] = 'E:/10. ACES/_OCIO_Color_Profiles/aces_1.2/config.ocio'
cfg = OCIO.Config.CreateFromFile(os.environ['OCIO'])
display = 'ACES'
view = 'sRGB'

processor = cfg.getProcessor(OCIO.ROLE_SCENE_LINEAR, display, view, OCIO.TRANSFORM_DIR_FORWARD)
cpu = processor.getDefaultCPUProcessor()

# Bake LUT at size 33 like gen_luts.py does
size = 33
steps = np.linspace(0.0, 1.0, size, dtype=np.float32)
b_axis, g_axis, r_axis = np.meshgrid(steps, steps, steps, indexing="ij")
flat = np.stack([r_axis.ravel(), g_axis.ravel(), b_axis.ravel()], axis=-1).astype(np.float32)
rgba_in = np.concatenate([flat, np.ones((flat.shape[0], 1), dtype=np.float32)], axis=-1)
cpu.applyRGBA(rgba_in)
rgb_out = np.clip(rgba_in[:, :3], 0.0, 1.0).astype(np.float32)
lut = rgb_out.reshape(size, size, size, 3)

# Sample Diffuse: input (0.088, 0.11, 0.11)
def lut_lookup(r, g, b, lut, size):
    n = size - 1
    fr = r * n
    fg = g * n
    fb = b * n
    r0 = int(np.floor(fr)); g0 = int(np.floor(fg)); b0 = int(np.floor(fb))
    r1 = min(r0 + 1, n); g1 = min(g0 + 1, n); b1 = min(b0 + 1, n)
    dr = fr - r0; dg = fg - g0; db = fb - b0
    def lerp(a, b, t): return a + (b - a) * t
    out = []
    for c in range(3):
        c000 = lut[b0, g0, r0, c]
        c100 = lut[b0, g0, r1, c]
        c010 = lut[b0, g1, r0, c]
        c110 = lut[b0, g1, r1, c]
        c001 = lut[b1, g0, r0, c]
        c101 = lut[b1, g0, r1, c]
        c011 = lut[b1, g1, r0, c]
        c111 = lut[b1, g1, r1, c]
        c00 = lerp(c000, c100, dr)
        c10 = lerp(c010, c110, dr)
        c01 = lerp(c001, c101, dr)
        c11 = lerp(c011, c111, dr)
        c0 = lerp(c00, c10, dg)
        c1 = lerp(c01, c11, dg)
        out.append(lerp(c0, c1, db))
    return out

samples = [
    ("Beauty", 0.8208, 0.8408, 0.9966),
    ("Diffuse", 0.0880, 0.1099, 0.1108),
    ("Shdw",   0.8550, 0.8550, 0.8477),
    ("SSS",    0.1324, 0.1070, 0.1201),
    ("Tran",   0.0084, 0.0072, 0.0090),
    ("Env",    0.2507, 0.2482, 0.2310),
]

print(f"{'Name':10s} {'Input':30s} {'LUT-33':30s} {'Reference':30s}")
print("=" * 100)
for name, r, g, b in samples:
    out_lut = lut_lookup(r, g, b, lut, size)
    out_ref = cpu.applyRGB([r, g, b])
    print(f"{name:10s} ({r:.4f},{g:.4f},{b:.4f})    ({out_lut[0]:.4f},{out_lut[1]:.4f},{out_lut[2]:.4f})    ({out_ref[0]:.4f},{out_ref[1]:.4f},{out_ref[2]:.4f})")