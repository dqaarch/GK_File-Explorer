#!/usr/bin/env python3
"""SketchUp (.skp) parser sidecar for Goku File Explorer.

Reads newline-delimited JSON commands on stdin and writes one JSON response
per line on stdout. Each request references a .skp file; we parse it via the
openskp Python package and return a GLB binary (base64-encoded) plus metadata
(version, layer count, definition count).

Only files saved by SketchUp 2021+ are supported (VFF binary format). Older
files return {"ok": false, "error": "skp_too_old"} so the frontend can show
a friendly fallback.

Protocol (NDJSON over stdin/stdout):

    {"cmd": "parse", "path": "C:/path/to/model.skp"}
    {"ok": true, "mime": "model/gltf-binary", "bytes": 15045468,
     "version": "23.1.341", "layers": 12, "definitions": 47,
     "glb": "<base64 GLB payload>"}
"""

from __future__ import annotations

import base64
import io
import json
import os
import sys
import tempfile
import traceback


# Minimum SketchUp version we can parse. VFF binary format landed in 2021;
# anything earlier uses MFC CArchive which openskp cannot read.
MIN_SUPPORTED_VERSION = 21


def _send(payload):
    """Write one JSON object as a single UTF-8 line and flush immediately."""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _recv():
    """Block until a full JSON line is read from stdin."""
    line = sys.stdin.readline()
    if not line:
        raise EOFError("stdin closed")
    return json.loads(line)


def _parse_float_version(version_str):
    """Extract the major version number from a SketchUp version string."""
    stripped = version_str.strip().strip("{}")
    if not stripped:
        return 0
    major = stripped.split(".")[0]
    try:
        return int(major)
    except ValueError:
        return 0


def _parse_skp(path):
    """Parse a .skp file and return a base64-encoded GLB payload."""
    if not os.path.isfile(path):
        return {"ok": False, "error": "file_not_found", "path": path}

    # Lazy imports keep the sidecar startup cheap when no .skp is requested.
    from openskp import SkpFile
    from openskp.export import glb

    skp = SkpFile.open(path)
    model = skp.parse()

    version = _parse_float_version(model.version)
    if version < MIN_SUPPORTED_VERSION:
        return {
            "ok": False,
            "error": "skp_too_old",
            "version": model.version,
            "minimum_version": MIN_SUPPORTED_VERSION,
        }

    buffer = io.BytesIO()
    with tempfile.TemporaryDirectory() as tmp_dir:
        stem = os.path.join(tmp_dir, "model")
        glb_path = glb.export(skp, stem)
        with open(glb_path, "rb") as fp:
            buffer.write(fp.read())

    glb_bytes = buffer.getvalue()
    encoded = base64.b64encode(glb_bytes).decode("ascii")

    return {
        "ok": True,
        "mime": "model/gltf-binary",
        "bytes": len(glb_bytes),
        "version": model.version,
        "layers": len(model.layers) if hasattr(model, "layers") else 0,
        "definitions": len(model.definitions) if hasattr(model, "definitions") else 0,
        "glb": encoded,
    }


def _main():
    """Run the NDJSON IPC loop until stdin closes."""
    try:
        sys.stdout.reconfigure(encoding="ascii", errors="replace")
    except (AttributeError, ValueError):
        pass

    while True:
        try:
            request = _recv()
        except EOFError:
            return 0
        except json.JSONDecodeError as exc:
            _send({"ok": False, "error": "bad_request", "detail": str(exc)})
            continue

        cmd = request.get("cmd")
        if cmd != "parse":
            _send({"ok": False, "error": "unknown_command", "cmd": cmd})
            continue

        path = request.get("path")
        if not isinstance(path, str) or not path:
            _send({"ok": False, "error": "missing_path"})
            continue

        try:
            response = _parse_skp(path)
        except Exception as exc:
            response = {
                "ok": False,
                "error": "parse_failed",
                "detail": str(exc),
                "trace": traceback.format_exc(limit=8),
            }
        _send(response)


if __name__ == "__main__":
    raise SystemExit(_main())