@echo off
REM regen_luts.bat — regenerate all OCIO 3D LUTs into a STAGING
REM directory for manual review before committing.
REM
REM Output goes to: bundle_dist/luts/_staging/  (NOT committed)
REM After review, copy the .bin files you want into:
REM                  bundle_dist/luts/           (committed to repo)
REM
REM Why staging instead of overwrite?
REM   - Lets you compare new vs old byte-by-byte or pixel-by-pixel
REM   - Avoids accidentally committing broken bakes
REM   - Multiple configs (ACES 1.3 CG, Studio, custom) can be diff'd
REM
REM Requires:
REM   - PyOpenColorIO 2.4+ (bundled in bundle_dist/python/)
REM   - numpy
REM
REM Usage from the repo root:
REM   src-tauri\Tools\regen_luts.bat
REM
REM After review, copy the staged files you want:
REM   copy /Y bundle_dist\luts\_staging\*.bin bundle_dist\luts\
REM   (or selectively with `xcopy /Y` for specific files)

setlocal enabledelayedexpansion

REM ─── Paths ──────────────────────────────────────────────────────────
set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%..\..\"
set "BUNDLE_LUTS_DIR=%PROJECT_ROOT%\bundle_dist\luts"
set "STAGING_DIR=%BUNDLE_LUTS_DIR%\_staging"
set "MANIFEST=%STAGING_DIR%\regen_manifest.txt"

REM Prefer the bundled Python interpreter shipped with the app (matches
REM what build.rs uses). Fall back to the system python.exe.
set "PYTHON_EXE=%PROJECT_ROOT%\bundle_dist\python\python.exe"
if not exist "%PYTHON_EXE%" (
    echo [regen_luts] Bundled python.exe not found, falling back to PATH
    set "PYTHON_EXE=python.exe"
)

set "PYTHONPATH=%PROJECT_ROOT%\bundle_dist\python\Lib\site-packages;%PYTHONPATH%"

echo.
echo ============================================================
echo  Regenerating OCIO LUTs from official v2.2.0 configs
echo  STAGING_DIR=%STAGING_DIR%
echo  PYTHON_EXE=%PYTHON_EXE%
echo ============================================================
echo.

REM Fresh staging directory each run — caller diff's against
REM bundle_dist/luts/ to decide what to copy.
if exist "%STAGING_DIR%" rmdir /S /Q "%STAGING_DIR%"
mkdir "%STAGING_DIR%"
echo Manifest of generated files: %MANIFEST% > "%MANIFEST%"

REM LUT grid resolution. Must match src-tauri/src/exr_ocio_lut.rs
REM DEFAULT_LUT_SIZE = 129. Changing this requires rebuilding
REM exr_ocio_lut.rs + shader constants.
set "LUT_SIZE=129"

REM ─── Identity passthroughs ─────────────────────────────────────────
REM Linear sRGB and Raw LUTs are pure identity over [0, 1] — no OCIO
REM needed. These are passthroughs that the shader treats specially.
echo [regen_luts] Baking Linear_sRGB identity LUT...
"%PYTHON_EXE%" "%SCRIPT_DIR%gen_luts.py" --mode "Linear sRGB" --size %LUT_SIZE% --out "%STAGING_DIR%\Linear_sRGB.bin"
if errorlevel 1 goto :error
echo   Linear_sRGB.bin>> "%MANIFEST%"

echo [regen_luts] Baking Raw identity LUT...
"%PYTHON_EXE%" "%SCRIPT_DIR%gen_luts.py" --mode "Raw" --size %LUT_SIZE% --out "%STAGING_DIR%\Raw.bin"
if errorlevel 1 goto :error
echo   Raw.bin>> "%MANIFEST%"

REM ─── Enumerate ACES 1.3 views ──────────────────────────────────────
echo.
echo [regen_luts] Enumerating (display, view) pairs from ACES 1.3 CG v2.2.0...
"%PYTHON_EXE%" "%SCRIPT_DIR%gen_luts.py" --mode "ACES 1.3 CG" --list-views > "%TEMP%\aces_cg_views.json"
if errorlevel 1 goto :error

echo [regen_luts] Enumerating (display, view) pairs from ACES 1.3 Studio v2.2.0...
"%PYTHON_EXE%" "%SCRIPT_DIR%gen_luts.py" --mode "ACES 1.3 Studio" --list-views > "%TEMP%\aces_studio_views.json"
if errorlevel 1 goto :error

REM ─── Bake each entry ───────────────────────────────────────────────
REM Pin the (display, view) explicitly so the LUT matches what the
REM OCIO config author intended. Output filename follows the existing
REM convention in build.rs:
REM   <slug> = "<config_slug>__<display_slug>__<view_slug>"
echo [regen_luts] Baking all entries (this may take 1-2 minutes per LUT)...
"%PYTHON_EXE%" -c ^
"import json, os, sys, subprocess ^
views_cg = json.load(open(os.environ['TEMP'] + r'\aces_cg_views.json')) ^
views_studio = json.load(open(os.environ['TEMP'] + r'\aces_studio_views.json')) ^
all_views = views_cg + views_studio ^
staging_dir = r'%STAGING_DIR%' ^
manifest = r'%MANIFEST%' ^
script = r'%SCRIPT_DIR%gen_luts.py' ^
size = %LUT_SIZE% ^
ok = 0 ^
fail = 0 ^
for v in all_views: ^
    out_path = os.path.join(staging_dir, v['lut_slug'] + '.bin') ^
    mode = v['config_name'] ^
    print(f'[regen_luts] Baking {v[\"lut_slug\"]}...') ^
    r = subprocess.run([r'%PYTHON_EXE%', script, '--mode', mode, '--size', str(size), '--display', v['display'], '--view', v['view'], '--out', out_path]) ^
    if r.returncode == 0: ^
        ok += 1 ^
        with open(manifest, 'a') as f: ^
            f.write(f'  {v[\"lut_slug\"]}.bin (display={v[\"display\"]!r}, view={v[\"view\"]!r})^n') ^
    else: ^
        fail += 1 ^
print(f'[regen_luts] Done: {ok} OK, {fail} failed') ^
sys.exit(0 if fail == 0 else 1)"

if errorlevel 1 goto :error

echo.
echo ============================================================
echo  All LUTs regenerated into STAGING directory
echo.
echo  STAGING:  %STAGING_DIR%
echo  BUNDLE:   %BUNDLE_LUTS_DIR%
echo.
echo  Next steps:
echo    1. Inspect the new .bin files in _staging\
echo    2. Compare against current files in bundle_dist\luts\
echo       (e.g. via fc /B or a hex diff)
echo    3. If satisfied, copy into the bundle:
echo         xcopy /Y /E /I %STAGING_DIR%\*.bin %BUNDLE_LUTS_DIR%\
echo    4. Re-run `npm run tauri:dev` to verify
echo ============================================================
exit /b 0

:error
echo.
echo ============================================================
echo  ERROR: LUT regeneration failed. See output above.
echo  Partial files may exist in %STAGING_DIR% — review before
echo  committing anything.
echo ============================================================
exit /b 1