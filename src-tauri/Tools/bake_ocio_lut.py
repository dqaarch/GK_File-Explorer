"""
bake_ocio_lut.py — bake a 3D LUT at runtime from an arbitrary OCIO config.

Called from Rust (src-tauri/src/main.rs) when the user supplies a custom
.ocio config file. Reads the OCIO config from `config_path`, applies the
default Display/View transform to a 3D LUT grid, and writes the result
to `out_path`.

Output binary layout matches the embedded LUTs baked by `gen_luts.py`:
    float32[size*size*size*3]
WebGL2 `texImage3D` row-major convention (R fastest on disk).

Usage:
    python bake_ocio_lut.py --config <path-to-config.ocio> \
                            --display <display_name> \
                            --view <view_name> \
                            --size 33 \
                            --out <out.bin>
"""

# Must match `gen_luts.LUT_INPUT_MAX` / `exr_ocio_lut::LUT_INPUT_MAX`
# so the shader / CPU renderer divide per-pixel linear values by this
# same constant before indexing. 16.29 is the ACES RRT peak scene white;
# most custom OCIO configs in this domain are ACES-derived (display
# view transforms that ultimately land on the ACES RRT), so we use the
# ACES domain as the conservative default. For configs that explicitly
# map scene-linear → display in a non-ACES pipeline, the user can
# override `input_max` via a future API call.
LUT_INPUT_MAX = 16.29

import argparse
import os
import sys

import numpy as np


def _ensure_ocio_on_path() -> None:
    """Make sure PyOpenColorIO can be imported when running outside the bundled Python."""
    try:
        import PyOpenColorIO  # noqa: F401
        return
    except ImportError:
        pass

    # Try site-packages relative to this script and standard locations.
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.abspath(os.path.join(here, "..", "..", "..", "bundle_dist", "python", "Lib", "site-packages")),
        os.path.abspath(os.path.join(here, "..", "..", "bundle_dist", "python", "Lib", "site-packages")),
    ]
    for c in candidates:
        if os.path.isdir(c) and c not in sys.path:
            sys.path.insert(0, c)
    for c in candidates:
        bin_dir = os.path.join(c, "PyOpenColorIO", "bin")
        if os.path.isdir(bin_dir):
            try:
                os.add_dll_directory(bin_dir)
            except Exception:
                pass


_ensure_ocio_on_path()


def list_displays_and_views(config):
    """Return (displays, views, default_display, default_view) from the config."""
    displays = list(config.getActiveDisplays())
    views = list(config.getActiveViews())
    try:
        default_display = config.getDefaultDisplay()
        default_view = config.getDefaultView(default_display)
    except Exception:
        default_display = displays[0] if displays else ""
        default_view = views[0] if views else ""
    return displays, views, default_display, default_view


def bake_lut(config_path: str, display: str, view: str, size: int, out_path: str) -> dict:
    """
    Bake a 3D LUT from the given config + display + view and write it to out_path.
    Returns a dict with metadata about the baked LUT (status, displays, views, etc.).
    """
    import PyOpenColorIO as OCIO

    if not config_path.startswith("ocio://") and not os.path.isfile(config_path):
        raise FileNotFoundError(f"OCIO config not found: {config_path}")

    # Load the config; set OCIO env to ensure relative searchPath resolution works.
    os.environ["OCIO"] = config_path
    config = OCIO.Config.CreateFromFile(config_path)

    displays, views, default_display, default_view = list_displays_and_views(config)

    # Fall back to defaults if user-supplied display/view is missing.
    if not display or display not in displays:
        print(f"[bake_ocio_lut] display '{display}' not found; using default '{default_display}'", flush=True)
        display = default_display
    if not view or view not in views:
        print(f"[bake_ocio_lut] view '{view}' not found; using default '{default_view}'", flush=True)
        view = default_view

    transform = OCIO.DisplayViewTransform()
    transform.setSrc(OCIO.ROLE_SCENE_LINEAR)
    transform.setDisplay(display)
    transform.setView(view)

    processor = config.getProcessor(transform)
    cpu = processor.getDefaultCPUProcessor()

    steps = np.linspace(0.0, LUT_INPUT_MAX, size, dtype=np.float32)
    # WebGL2 layout + numpy row-major: voxel [b_idx, g_idx, r_idx] is the
    # OCIO output for input (r=steps[r_idx], g=steps[g_idx], b=steps[b_idx])
    # and the shader/loader read it via flat offset
    # `((b*N + g)*N + r) * 3` (see exr_ocio_lut.rs:8-13 and
    # EXRGpuRenderer.ts:806-807 `sampleLut`). Meshgrid with
    # `indexing="ij"` puts the first unpacked arg on i (b), second on j
    # (g), third on k (r) of the (N, N, N) axes.
    b_axis, g_axis, r_axis = np.meshgrid(steps, steps, steps, indexing="ij")
    flat = np.stack([r_axis.ravel(), g_axis.ravel(), b_axis.ravel()], axis=-1).astype(np.float32)
    rgba_in = np.concatenate(
        [flat, np.ones((flat.shape[0], 1), dtype=np.float32)], axis=-1
    )
    cpu.applyRGBA(rgba_in)
    # Do NOT clip to [0, 1] — negative values are essential for accurate
    # trilinear interpolation. See gen_luts.py for full explanation.
    rgb_out = rgba_in[:, :3].astype(np.float32)
    lut = rgb_out.reshape(size, size, size, 3)
    lut.tofile(out_path)

    return {
        "status": "ok",
        "config_path": config_path,
        "display": display,
        "view": view,
        "size": size,
        "out_path": out_path,
        "displays": displays,
        "views": views,
        "default_display": default_display,
        "default_view": default_view,
        "range_min": float(lut.min()),
        "range_max": float(lut.max()),
        # Inform the Rust caller what input domain this LUT was baked
        # over so the GPU shader / CPU renderer divide by the same
        # constant before indexing. Must stay in sync with
        # `gen_luts.LUT_INPUT_MAX`.
        "input_max": float(LUT_INPUT_MAX),
    }


def list_displays_for(config_path: str) -> dict:
    """Return the available displays + views + defaults for the given config (no LUT baking)."""
    import PyOpenColorIO as OCIO

    if not config_path.startswith("ocio://") and not os.path.isfile(config_path):
        raise FileNotFoundError(f"OCIO config not found: {config_path}")

    os.environ["OCIO"] = config_path
    config = OCIO.Config.CreateFromFile(config_path)
    displays, views, default_display, default_view = list_displays_and_views(config)
    return {
        "status": "ok",
        "displays": displays,
        "views": views,
        "default_display": default_display,
        "default_view": default_view,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Bake a 3D LUT from a custom OCIO config at runtime.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    bake_p = sub.add_parser("bake", help="Bake a 3D LUT and write to a binary file.")
    bake_p.add_argument("--config", required=True, help="Path to .ocio config file")
    bake_p.add_argument("--display", default="", nargs="?", help="Display name (default if missing)")
    bake_p.add_argument("--view", default="", nargs="?", help="View name (default if missing)")
    bake_p.add_argument("--size", type=int, default=33)
    bake_p.add_argument("--out", required=True, help="Output .bin path")

    list_p = sub.add_parser("list", help="List displays + views of a config without baking.")
    list_p.add_argument("--config", required=True)

    args = parser.parse_args()

    if args.cmd == "bake":
        try:
            meta = bake_lut(args.config, args.display, args.view, args.size, args.out)
        except Exception as e:
            print(f"[bake_ocio_lut] ERROR: {e}", flush=True)
            import traceback
            traceback.print_exc()
            return 2
        # Single-line JSON status for the Rust caller to grep.
        import json
        print("META_JSON_BEGIN")
        print(json.dumps(meta))
        print("META_JSON_END")
        return 0

    if args.cmd == "list":
        try:
            meta = list_displays_for(args.config)
        except Exception as e:
            print(f"[bake_ocio_lut] ERROR: {e}", flush=True)
            return 2
        import json
        print("META_JSON_BEGIN")
        print(json.dumps(meta))
        print("META_JSON_END")
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())