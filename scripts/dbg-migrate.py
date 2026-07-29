"""
Safe bulk-migrate `console.log(...)` -> `dbg.log(...)` in selected frontend
files. Preserves `console.warn` and `console.error` (those are real-error
paths the user wants kept).
"""
import re
from pathlib import Path

ROOT = Path(r"F:\Goku File Explorer Light\src")

TARGETS = [
    ROOT / "utils" / "exrCache" / "LayerCacheManager.ts",
    ROOT / "utils" / "exrCache" / "exrGpuPipeline.ts",
    ROOT / "utils" / "exrCache" / "EXRGpuRenderer.ts",
    ROOT / "utils" / "exrCache" / "RawLinearCache.ts",
    ROOT / "utils" / "exrCache" / "ImageBitmapCache.ts",
    ROOT / "components" / "exrPlayer" / "useContinuousLoader.ts",
]

# Pre-flight: every file must already import `dbg` from somewhere.
# If not, we abort and the operator adds the import.
def has_dbg_import(p: Path) -> bool:
    return re.search(r"from ['\"][^'\"]*debug['\"]", p.read_text(encoding="utf-8")) is not None


def migrate_one(p: Path) -> tuple[int, int]:
    text = p.read_text(encoding="utf-8")
    # We only migrate console.log( -> dbg.log(. console.warn/error stay.
    # Multi-line console.log also handled since we match `console.log`.
    # Use lookbehind/lookahead-free global replace; that's safe because
    # the JS identifier is exactly `console.log` and nothing else should
    # contain `console.log` other than real calls.
    new_text, n = re.subn(r"\bconsole\.log\b", "dbg.log", text)
    if n and "from \"./debug\"" not in new_text and "from \"../debug\"" not in new_text and "from \"../../utils/debug\"" not in new_text:
        # Make sure we still have the import after the edit.
        for hint in ("from '../debug'", 'from "./debug"', 'from "../../utils/debug"', 'from "../../../utils/debug"'):
            if hint in new_text:
                break
        else:
            raise RuntimeError(
                f"{p}: dbg import missing — please add it manually before running this script."
            )
    p.write_text(new_text, encoding="utf-8")
    return n, len(text.splitlines())


for path in TARGETS:
    if not path.exists():
        print(f"SKIP missing {path}")
        continue
    if not has_dbg_import(path):
        print(f"ABORT {path}: dbg import missing")
        continue
    n, lines = migrate_one(path)
    print(f"OK   {path.relative_to(ROOT.parent)}: {n} console.log -> dbg.log ({lines} lines)")
