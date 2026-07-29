"""
gen_luts.py — generate OCIO 3D LUTs as raw float32 binary files.

Called by src-tauri/build.rs at build time. Produces one .bin per OCIO
mode under the Cargo OUT_DIR; main.rs then `include_bytes!`s them.

Output binary layout (matches the WebGL2 sampler3D convention used by
EXRGpuRenderer.ts):

    float32[size*size*size*3]

When uploaded via `texImage3D(target, 0, RGB32F, size, size, size, 0,
RGB, FLOAT, data)`, WebGL2 interprets the flat array in row-major order
with x varying FASTEST and z varying SLOWEST (a la 3D texture layout in
the spec). `texture(u_lut, vec3(r, g, b))` in the fragment shader then
maps the three components to (x, y, z) = (R, G, B), so we need R to vary
fastest on disk. The on-disk layout is therefore:

    offset = ((b * size + g) * size + r) * 3   # R innermost, B outermost

`include_bytes!` copies the data straight into the binary so the final
exe carries no external LUT dependency. If Python / OCIO isn't available
at build time the build script falls back to writing an identity LUT for
each mode so the build still succeeds.

Usage:
    python gen_luts.py --mode ACES_2_0_CG --size 33 --out lut_aces_cg.bin
"""

# Input domain for the baked LUT.
# ACES modes use [0, 16.29] to cover the full HDR range that ACES RRT outputs.
# This ensures EXR pixels > 1.0 are properly tone-mapped through the LUT.
# Linear sRGB / Raw use [0, 1] (passthrough modes).
IDENTITY_LUT_INPUT_MAX = 1.0
ACES_LUT_INPUT_MAX = 16.29

import argparse
import os
import sys
import struct
import numpy as np




def _ensure_ocio_on_path() -> None:
    """Make sure PyOpenColorIO can be imported when running outside the bundled Python.

    When build.rs invokes the bundled `bundle_dist/python/python.exe` it already
    adds the right site-packages, but if the user runs this script with the
    system Python we still want it to find the bundled OpenColorIO.
    """
    try:
        import PyOpenColorIO  # noqa: F401
        return
    except ImportError:
        pass

    # Look for the bundled site-packages relative to this script.
    here = os.path.dirname(os.path.abspath(__file__))
    # Tools/ -> src-tauri/ -> <repo>/; bundled python lives in <repo>/bundle_dist/python
    candidates = [
        os.path.abspath(os.path.join(here, "..", "..", "bundle_dist", "python", "Lib", "site-packages")),
    ]
    for c in candidates:
        if os.path.isdir(c) and c not in sys.path:
            sys.path.insert(0, c)
    # Also let the dynamic loader find OpenColorIO_2_5.dll next to the .pyd.
    for c in candidates:
        bin_dir = os.path.join(c, "PyOpenColorIO", "bin")
        if os.path.isdir(bin_dir):
            os.add_dll_directory(bin_dir)


_ensure_ocio_on_path()


def _linear_to_srgb(rgb: np.ndarray) -> np.ndarray:
    """Apply sRGB OETF: linear -> sRGB transfer function.
    
    Matches the shader's `linearToSRGB()` function.
    For each channel: if c <= 0.0031308: c * 12.92, else: 1.055 * c^(1/2.4) - 0.055
    """
    mask = rgb <= 0.0031308
    result = np.empty_like(rgb)
    result[mask] = rgb[mask] * 12.92
    result[~mask] = 1.055 * np.power(rgb[~mask], 1.0 / 2.4) - 0.055
    return result


def generate_identity_lut(size: int, out_path: str, lut_input_max: float = 1.0) -> None:
    """Write an identity 3D LUT — used as the no-Python fallback.

    The voxel order must match what `generate_ocio_lut` writes so the
    shader sees identical layout whether OCIO is available or not.
    After the OCIO LUT bug fix (R/B axis swap) the canonical layout
    is `lut[i, j, k, :] = (r_out, g_out, b_out)` for input
    `(r=steps[i], g=steps[j], b=steps[k])`, i.e. axis 0 = r,
    axis 1 = g, axis 2 = b.

    `lut_input_max` is the scene-linear input domain the LUT is baked
    over — `1.0` for identity passthroughs (Linear sRGB / Raw) and
    `16.29` for ACES identity fallbacks (where the runtime would route
    through inline ACES anyway, but the LUT axes still need to match
    the shader's `u_lutInputMax` to avoid silently darkening the LUT
    endpoint).
    """
    steps = np.linspace(0.0, lut_input_max, size, dtype=np.float32)
    # Unpack meshgrid as (b, g, r) -- numpy row-major `lut[i, j, k, c]`
    # at flat offset ((i*N + j)*N + k)*3 + c, so the k-axis changes
    # fastest and the i-axis slowest. Mapping the shader/loader flat
    # offset `idx(r, g, b) = ((b*N + g)*N + r)*3` onto that layout
    # means `lut[b_idx, g_idx, r_idx]` is the OCIO output for input
    # (r=steps[r_idx], g=steps[g_idx], b=steps[b_idx]). `meshgrid(...,,
    # indexing="ij")` puts the third arg on the i-axis, second on j,
    # third on k; by stacking `(r_axis, g_axis, b_axis)` from the
    # unpacked order `(b, g, r)` the channels land in the right slot.
    b_axis, g_axis, r_axis = np.meshgrid(steps, steps, steps, indexing="ij")
    lut = np.stack([r_axis, g_axis, b_axis], axis=-1).astype(np.float32)
    write_binary(lut, out_path)


def generate_ocio_lut(
    mode: str,
    size: int,
    out_path: str,
    display_override: str = "",
    view_override: str = "",
) -> bool:
    """
    Generate a 3D LUT for the given OCIO mode using PyOpenColorIO.
    Returns True on success, False on any error (caller should fall back
    to the identity LUT to keep the build green).

    `display_override` / `view_override` let the caller pin a specific
    Display+View pair (used by `build.rs` to bake one LUT per View
    Transform — the AE-style "ACES 1.0 SDR Video", "Video", "Cineon",
    etc.). When empty we fall back to the config's `getDefaultDisplay()`
    + `getDefaultView()` for backwards compatibility with the legacy
    single-mode API.
    """
    try:
        import PyOpenColorIO as OCIO  # type: ignore
    except Exception as e:
        print(f"[gen_luts] PyOpenColorIO not available ({e}); using identity LUT", flush=True)
        return False

    try:
        # Resolve OCIO config — see exr_decoder.py:67-82 for the same logic.
        # OCIO 2.x ships official built-in configs via the BuiltinConfigRegistry.
        # These URLs are stable across OCIO v2.0+ and resolve to the latest
        # bundled version of the named config. To pin a specific version
        # (e.g. v2.2.0) set the OCIO_BUILTIN_CONFIG_VERSION env var, or
        # hardcode the versioned URL below.
        #
        # The previous hardcoded "cg-config-v1.0.0_aces-v1.3_ocio-v2.1"
        # URL corresponds to the 2022-03 release; the current latest is
        # "cg-config-v2.2.0_aces-v1.3_ocio-v2.4" (Sep 2024) which adds
        # ACES 1.3 Reference Gamut Compression, updated Output Transforms
        # (Rec.2100 HLG OETF, Rec.2100 PQ refinements) and ColorInterop
        # Forum naming conventions.
        if mode == "$OCIO":
            env_config = os.environ.get("OCIO")
            if env_config and (os.path.exists(env_config) or env_config.startswith("ocio://")):
                config = OCIO.Config.CreateFromFile(env_config)
            else:
                print("[gen_luts] $OCIO env var missing; falling back to identity LUT")
                return False
        elif mode == "ACES 1.3 Studio":
            config = OCIO.Config.CreateFromFile("ocio://studio-config-v2.2.0_aces-v1.3_ocio-v2.4")
        elif mode == "ACES 1.3 CG":
            config = OCIO.Config.CreateFromFile("ocio://cg-config-v2.2.0_aces-v1.3_ocio-v2.4")
        elif mode == "Raw":
            config = OCIO.Config.CreateFromFile("ocio://default")
        elif mode == "Linear sRGB":
            # Identity — Linear sRGB has no display transform; ship identity
            # LUT so the GPU path has something to bind. Range stays [0, 1]
            # because this mode is a passthrough and the shader's
            # `c / lut_input_max` divide must be a no-op for it.
            generate_identity_lut(size, out_path, IDENTITY_LUT_INPUT_MAX)
            return True
        else:
            print(f"[gen_luts] Unknown mode '{mode}'; using identity LUT")
            generate_identity_lut(size, out_path, IDENTITY_LUT_INPUT_MAX)
            return True

        if display_override and view_override:
            display = display_override
            view = view_override
        else:
            display = config.getDefaultDisplay()
            view = config.getDefaultView(display)

        # Look up the per-mode input domain.
        # OCIO view transforms that include the ACES RRT need the full
        # HDR scene-referred input range [0, 16.29] (the ACES peak
        # scene white). "Un-tone-mapped" / "Raw" skip the tone curve
        # and operate on the linear sRGB domain [0, 1]; baking them
        # over [0, 16.29] compresses real scene-linear values into the
        # first 6% of the LUT, producing visibly darkened / muted
        # output.
        #
        # Match the view name case-insensitively and as a substring,
        # so e.g. "Raw", "RAW", "Un-tone-mapped", "Un-Tone-Mapped",
        # "UntoneMapped" all collapse to the same identity input range.
        view_lower = view.lower().strip()
        is_passthrough_view = (
            view_lower == "raw"
            or view_lower == "un-tone-mapped"
            or view_lower == "untonemapped"
            or "untone" in view_lower
        )
        if mode in ("ACES 1.3 Studio", "ACES 1.3 CG"):
            if is_passthrough_view:
                lut_input_max = IDENTITY_LUT_INPUT_MAX
            else:
                lut_input_max = ACES_LUT_INPUT_MAX
        else:
            lut_input_max = IDENTITY_LUT_INPUT_MAX
        steps = np.linspace(0.0, lut_input_max, size, dtype=np.float32)
        # WebGL2 `texImage3D` row-major + flat offset
        # `idx(r, g, b) = ((b*N + g)*N + r)*3` (see exr_ocio_lut.rs:8-13
        # and EXRGpuRenderer.ts:806-807 `sampleLut`). Numpy reshape
        # `lut[i, j, k, c]` lands at flat `(i*N*N + j*N + k)*3 + c`,
        # so i=b_idx, j=g_idx, k=r_idx. We therefore need
        # `lut[b_idx, g_idx, r_idx]` to hold the OCIO output for input
        # (r=steps[r_idx], g=steps[g_idx], b=steps[b_idx]).
        #
        # `meshgrid(steps, steps, steps, indexing="ij")` puts the first
        # arg on i, second on j, third on k — so unpacking as
        # `(b, g, r)` and stacking `(r, g, b)` along the channel axis
        # places the right sample at the right flat offset.
        b_axis, g_axis, r_axis = np.meshgrid(steps, steps, steps, indexing="ij")
        flat = np.stack(
            [r_axis.ravel(), g_axis.ravel(), b_axis.ravel()], axis=-1
        ).astype(np.float32)

        # Per the OCIO cleanup (June 2026) — match the OCIO behaviour
        # of the previous Goku release. The built-in `cg-config-latest`
        # / `studio-config-latest` configs already resolve scene-linear
        # EXR pixels through OCIO's own IDT machinery (the config sets
        # `ROLE_SCENE_LINEAR` appropriately and uses the right AP1
        # OutputTransform). Pre-multiplying samples here would double up
        # the IDT and shift saturation away from what the OCIO config
        # authors intended — visually reported as "more saturated than
        # AE" versus the older release that ran with no IDT pre-multiply.
        # Therefore: do NOT apply any IDT ourselves; feed the raw
        # scene-linear grid straight to OCIO DisplayViewTransform and
        # let the config choose the source colorspace.

        # OCIO CPU apply expects RGBA — pad alpha = 1.0
        rgba_in = np.concatenate(
            [flat, np.ones((flat.shape[0], 1), dtype=np.float32)], axis=-1
        )
        transform = OCIO.DisplayViewTransform()
        # EXR pixels for these modes are stored in scene-linear color
        # spaces whose primaries and transfer differ, so setSrc() must
        # be pinned to the matching source colorspace name. Rather
        # than hardcoding a single source per mode, we ask the OCIO
        # config itself what role its view transforms expect, then
        # fall back to a sensible default if that role is unset.
        #
        # The new OCIO 1.3 / 2.x configs set `ROLE_SCENE_LINEAR` to
        # ACEScg (CG/Studio configs) or to Linear Rec.709 (Linear sRGB
        # passthrough). Reading the role via Config.getRoleName() lets
        # us pick up whichever colorspace the config author wired in,
        # without baking in a per-mode mapping that drifts when the
        # config changes.
        try:
            src_role = config.getRoleName(OCIO.ROLE_SCENE_LINEAR) or ""
        except Exception:
            src_role = ""
        if not src_role:
            # Fallback for legacy configs / Studio configs that don't
            # set ROLE_SCENE_LINEAR explicitly: pin to ACEScg for any
            # ACES-tagged mode, Linear Rec.709 for passthrough modes.
            if mode in ("ACES 1.3 Studio", "ACES 1.3 CG"):
                src_role = "ACEScg"
            elif mode == "Linear sRGB":
                src_role = "Linear Rec.709 (sRGB)"
            else:
                src_role = OCIO.ROLE_SCENE_LINEAR
        transform.setSrc(src_role)
        print(f"[gen_luts] Using setSrc='{src_role}' (from config role) for mode={mode}", flush=True)
        transform.setDisplay(display)
        transform.setView(view)
        processor = config.getProcessor(transform)
        cpu = processor.getDefaultCPUProcessor()
        cpu.applyRGBA(rgba_in)
        # Get linear output from OCIO.
        # OCIO DisplayViewTransform in cg-config / studio-config already
        # applies the display's encoding transform (sRGB OETF, Rec.1886
        # OETF, Rec.2100 OETF, ...). AE's OCIO plugin does the same.
        # Applying _linear_to_srgb() here previously caused a double OETF
        # (LUT pre-encoded gamma, then the shader pow() ran AGAIN when
        # u_lutBakedSrgbOetf was 0) — visually reported as muted reds /
        # greens and lifted midtones. Leave the output untouched.
        rgb_out = rgba_in[:, :3].astype(np.float32)

        # IMPORTANT: Do NOT clip the output to [0, 1]. OCIO DisplayViewTransform
        # produces negative values for highly saturated ACEScg primaries (e.g.
        # (1,0,0) -> (0.96, -0.72, -0.005)). Clipping to [0,1] destroys these
        # negative values, and trilinear interpolation then produces wrong results
        # for mid-tone values (G/B channels off by ~0.05). The negative values
        # are essential for accurate hue reproduction after interpolation.
        # The sRGB OETF (applied by the shader) naturally handles negative values
        # by outputting 0, so no clipping is needed at display time either.
        # Reshape (N^3, 3) -> (N, N, N, 3). The OCIO input was stacked
        # from `r_axis, g_axis, b_axis` of `meshgrid` unpacked as
        # `(b, g, r)` -- ravel runs over (i=b, j=g, k=r) in that order --
        # so the flat array has pure-R samples at rows where k=last, and
        # after reshape:
        #   lut[i, j, k, :] = (steps[k], steps[j], steps[i])
        #                   = (r,         g,       b)     for input
        #                     (r=steps[k], g=steps[j], b=steps[i])
        # i.e. axis 0 = b, axis 1 = g, axis 2 = r.
        #
        # The shader samples with flat offset
        # `idx(r, g, b) = ((b*N + g)*N + r)*3`, which numpy lays out as
        # `lut[b_idx, g_idx, r_idx, c]` -- exactly the OCIO output for
        # input (r=steps[r_idx], g=steps[g_idx], b=steps[b_idx]). No
        # transpose needed because the channel order matches the shader's
        # flat addressing convention.
        lut = rgb_out.reshape(size, size, size, 3)

        write_binary(lut, out_path)

        # Sanity check: verify that the corners of the baked LUT
        # correspond to the expected hue for a pure-channel input.
        # Without this check, a future refactor that re-introduces a
        # stray transpose would silently corrupt every ACES render with
        # a green-cyan / red-deficient cast, only visible after the
        # full Rust rebuild and a manual eyeball comparison with AE.
        # For ACES + sRGB OETF the expected hues are roughly:
        #   pure red   ~ (0.7, 0.05, 0.05)  -- R dominant, B smallest
        #   pure green ~ (0.05, 0.85, 0.15) -- G dominant
        #   pure blue  ~ (0.10, 0.10, 0.95) -- B dominant, R smallest
        # For identity / linear-sRGB modes the corners equal the input
        # exactly. We assert the dominant-channel ordering instead of
        # hard-coded magnitudes so the check survives OCIO config
        # version bumps.
        if size >= 3:
            last = size - 1
            # lut axis 0 = b, axis 1 = g, axis 2 = r. So corners are:
            #   lut[last, 0, 0]  = OCIO out for input (0, 0, max)        = pure B
            #   lut[0, last, 0]  = OCIO out for input (0, max, 0)        = pure G
            #   lut[0, 0, last]  = OCIO out for input (max, 0, 0)        = pure R
            pure_b_v = lut[last, 0, 0]
            pure_g_v = lut[0, last, 0]
            pure_r_v = lut[0, 0, last]
            # B must dominate at lut[last, 0, 0]
            assert pure_b_v[2] >= pure_b_v[0] and pure_b_v[2] >= pure_b_v[1], (
                f"[gen_luts] SANITY FAIL: blue corner {pure_b_v.tolist()} does "
                f"not have B as the dominant channel -- R/B axes are likely "
                f"swapped in the .bin. Re-check the meshgrid + reshape block."
            )
            # G must dominate at lut[0, last, 0]
            assert pure_g_v[1] >= pure_g_v[0] and pure_g_v[1] >= pure_g_v[2], (
                f"[gen_luts] SANITY FAIL: green corner {pure_g_v.tolist()} does "
                f"not have G as the dominant channel."
            )
            # R must dominate at lut[0, 0, last]
            assert pure_r_v[0] >= pure_r_v[1] and pure_r_v[0] >= pure_r_v[2], (
                f"[gen_luts] SANITY FAIL: red corner {pure_r_v.tolist()} does "
                f"not have R as the dominant channel -- R/B axes are likely "
                f"swapped in the .bin. Re-check the meshgrid + reshape block."
            )

        print(
            f"[gen_luts] OK: mode={mode} size={size} input=[0.0, {lut_input_max:.4f}] output_range=[{lut.min():.4f}, {lut.max():.4f}] -> {out_path}",
            flush=True,
        )
        return True

    except Exception as e:
        print(f"[gen_luts] OCIO failure for mode={mode}: {e}", flush=True)
        import traceback
        traceback.print_exc()
        return False


def write_binary(lut: np.ndarray, out_path: str) -> None:
    """Write the (size, size, size, 3) float32 array as a contiguous .bin."""
    if lut.dtype != np.float32:
        lut = lut.astype(np.float32)
    lut.tofile(out_path)


def _slugify(text: str) -> str:
    """Make a string safe to use as a Rust identifier / file slug.

    Replace any non-alphanumeric char with `_`, collapse runs of `_`,
    strip leading/trailing `_`. Result is ASCII-safe and stable so the
    build script can rely on a 1:1 mapping between slugs and
    `include_bytes!` paths.
    """
    out = []
    prev_us = False
    for ch in text:
        if ch.isalnum():
            out.append(ch)
            prev_us = False
        else:
            if not prev_us:
                out.append("_")
                prev_us = True
    s = "".join(out).strip("_")
    return s or "unknown"


def list_ocio_views(
    config_url: str,
    whitelist: list[str] | None = None,
    display_filter: str = "sRGB - Display",
) -> list[dict]:
    """Enumerate every (display, view) pair available in the given OCIO
    config. Returns a list of dicts with keys `display`, `view`, and
    `slug` (the sanitised concatenation used as the .bin file stem).

    If `whitelist` is non-empty, only views whose name is in the list
    (case-insensitive, normalised) are returned. The whitelist is
    matched against the raw OCIO view name, so it can be used both to
    include legacy names ("ACES 1.0 SDR Video") and the OCIO 2.x
    replacement names ("ACES 2.0 - SDR 100 nits (Rec.709)") by passing
    both strings.

    `display_filter` restricts the enumeration to a single display
    (default "sRGB - Display") — the typical desktop monitor. The
    `cg-config-latest` / `studio-config-latest` configs expose 7+
    displays (P3, Rec.1886, Rec.2100-PQ, ST2084, ...) that the EXR
    Player dropdown would never surface, so baking LUTs for all of
    them just inflates the binary. Pass an empty string to disable
    the filter and enumerate every display.

    Falls back to an empty list on any error (caller should treat that
    as "no OCIO available").
    """
    try:
        import PyOpenColorIO as OCIO  # type: ignore
    except Exception:
        return []
    try:
        config = OCIO.Config.CreateFromFile(config_url)
    except Exception as e:
        print(f"[gen_luts] list_ocio_views: cannot open {config_url}: {e}", flush=True)
        return []
    out = []
    for display in config.getDisplays():
        if display_filter and display != display_filter:
            continue
        try:
            views = list(config.getViews(display))
        except Exception:
            views = []
        for view in views:
            if whitelist:
                norm = view.strip().lower()
                if not any(w.strip().lower() == norm for w in whitelist):
                    continue
            slug = _slugify(f"{display}__{view}")
            out.append({"display": display, "view": view, "slug": slug})
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate OCIO 3D LUT binary")
    parser.add_argument("--mode", required=True, help="OCIO mode (Linear_sRGB, ACES_2_0_CG, ...)")
    parser.add_argument("--size", type=int, default=33, help="LUT grid resolution (default: 33)")
    parser.add_argument("--out", required=True, help="Output .bin path")
    parser.add_argument(
        "--display", default="",
        help="Override OCIO display name (paired with --view). Used by build.rs "
             "to bake one LUT per (display, view) pair.",
    )
    parser.add_argument(
        "--view", default="",
        help="Override OCIO view name (paired with --display).",
    )
    parser.add_argument(
        "--list-views", action="store_true",
        help="Print JSON list of {config_url, display, view, slug} to stdout "
             "and exit. Used by build.rs to enumerate every (display, view) "
             "pair the config exposes.",
    )
    args = parser.parse_args()

    if args.list_views:
        # Resolve the config URL the same way generate_ocio_lut does so the
        # enumeration matches what the bake call will actually load.
        # See the comment in generate_ocio_lut for why we now pin the
        # v2.2.0 official configs (2024) instead of the legacy v1.0.0.
        config_url = ""
        if args.mode == "ACES 1.3 Studio":
            config_url = "ocio://studio-config-v2.2.0_aces-v1.3_ocio-v2.4"
        elif args.mode == "ACES 1.3 CG":
            config_url = "ocio://cg-config-v2.2.0_aces-v1.3_ocio-v2.4"
        elif args.mode == "Raw":
            config_url = "ocio://default"
        elif args.mode == "$OCIO":
            env_config = os.environ.get("OCIO", "")
            if env_config and (os.path.exists(env_config) or env_config.startswith("ocio://")):
                config_url = env_config
        # No whitelist, no display filter -- enumerate EVERY
        # (display, view) pair so the EXR Player dropdown mirrors
        # After Effects exactly (sRGB-Display, Rec.1886 Rec.709,
        # Rec.2100-PQ, ST2084-P3-D65, P3-D65, P3-DCI, P3-D60, etc.).
        # CG yields 5 displays x 3 views = 15 LUTs; Studio yields
        # 9 displays x ~4 views = ~35 LUTs. Total stays under 50
        # entries / ~40 MB binary overhead.
        views = list_ocio_views(config_url, None, display_filter="") if config_url else []
        # Emit one entry per (display, view) so build.rs can pass
        # `--display` + `--view` back into generate_ocio_lut. We
        # include `config_name` so the Rust side can group entries
        # into a 2-level UI menu (OCIO mode -> View Transform).
        import json
        out = [
            {
                "config_name": args.mode,
                "config_slug": _slugify(args.mode),
                "config_url": config_url,
                "display": v["display"],
                "view": v["view"],
                "lut_slug": f"{_slugify(args.mode)}__{v['slug']}",
            }
            for v in views
        ]
        print(json.dumps(out))
        return 0

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)

    if not generate_ocio_lut(args.mode, args.size, args.out, args.display, args.view):
        # Always fall back to identity so the build can complete even
        # when Python / OCIO isn't available on the build host. The
        # fallback identity range must match what the Rust side reports
        # as `input_max` for this mode — we use IDENTITY (1.0) because
        # the runtime identity-detector routes to inline ACES anyway
        # and the Raw / Linear sRGB axes must stay [0, 1] so the
        # shader's `c / lut_input_max` divide is a no-op.
        print(f"[gen_luts] Falling back to identity LUT for {args.out}", flush=True)
        generate_identity_lut(args.size, args.out, IDENTITY_LUT_INPUT_MAX)

    return 0


if __name__ == "__main__":
    sys.exit(main())