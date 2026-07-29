# build.ps1 - wasm_src build script
#
# Phase 0: smoke test dummy wasm.
# Phase 1: real Alembic loader wasm (alembic_glue.cpp).
# Phase 2: wabc smoke test wasm (wabc_smoke.cpp).
# Phase 3: wabc full wasm (wabc_js_binding.cpp + SceneABC.cpp).
#
# Usage:
#   cd wasm_src
#   .\build.ps1              # default = Phase 0 smoke test
#   .\build.ps1 -Phase 1 -Vendor
#   .\build.ps1 -Phase 2 -Vendor
#   .\build.ps1 -Phase 3 -Vendor

param(
  [ValidateSet(0, 1, 2, 3)]
  [int]$Phase = 0,

  [switch]$Vendor = $false
)

$ErrorActionPreference = "Stop"
$WASM_SRC   = $PSScriptRoot
$EMSDK_DIR  = Join-Path $WASM_SRC "emsdk"
$EMSCRIPTEN = Join-Path $EMSDK_DIR "upstream\emscripten"
$BUILD0_DIR = Join-Path $WASM_SRC "build_smoke"
$BUILD1_DIR = Join-Path $WASM_SRC "build_glue"
$BUILD2_DIR = Join-Path $WASM_SRC "build_wabc_smoke"
$BUILD3_DIR = Join-Path $WASM_SRC "build_wabc"
$PUBLIC_DIR = Join-Path $WASM_SRC "..\public\wasm\alembic"
# Tauri v2 dev loads from the debug resources dir. Keep in sync with public/.
$TAURI_RES = Join-Path $WASM_SRC "..\src-tauri\target\debug\resources\wasm\alembic"

# ----------------------------------------------------------------------------
# Setup: activate emsdk + add tools to PATH
# ----------------------------------------------------------------------------
Write-Host "[build] Setting up Emscripten environment..." -ForegroundColor Cyan
$env:EMSDK_QUIET = "1"
$constructOutput = & python (Join-Path $EMSDK_DIR "emsdk.py") construct_env 2>&1 | Out-String
$env:EMSDK_QUIET = $null
# Parse "KEY = VALUE" lines from construct_env output
$constructOutput -split "`n" | ForEach-Object {
  $line = $_.Trim()
  if ($line -match '^([A-Z_][A-Z0-9_]*) = (.+)$') {
    $name = $matches[1]
    $val = $matches[2].Trim()
    if ($name -eq 'PATH') {
      $env:PATH = $val + ";" + $env:PATH
    } else {
      Set-Item -Path "env:$name" -Value $val
    }
  }
}

$NINJA_BIN = Join-Path $WASM_SRC "bin"
$env:PATH = "$NINJA_BIN;$EMSCRIPTEN;$env:PATH"

$emxx = Get-Command em++ -ErrorAction SilentlyContinue
if (-not $emxx) { throw "em++ not found after sourcing EMSDK env." }

$NINJA = Join-Path $NINJA_BIN "ninja.exe"
if (-not (Test-Path $NINJA)) {
  Write-Host "[build] Downloading ninja..." -ForegroundColor Yellow
  $tmpZip = Join-Path $env:TEMP "ninja.zip"
  Invoke-WebRequest -Uri "https://github.com/ninja-build/ninja/releases/download/v1.13.0/ninja-win.zip" `
                     -OutFile $tmpZip -UseBasicParsing
  New-Item -ItemType Directory -Force -Path $NINJA_BIN | Out-Null
  Expand-Archive -Path $tmpZip -DestinationPath $NINJA_BIN -Force
  Remove-Item $tmpZip
}
$env:PATH = "$NINJA_BIN;$env:PATH"
$ninja_ver = & ninja --version
Write-Host "[build] ninja version: $ninja_ver" -ForegroundColor Green

# Fixed paths for CMake toolchain
$TC_FILE  = Join-Path $EMSCRIPTEN "cmake\Modules\Platform\Emscripten.cmake"
$NODE_EXEC = Join-Path $EMSDK_DIR "node\22.16.0_64bit\bin\node.exe"

# ----------------------------------------------------------------------------
# Helper: build using cmake + ninja via Python wrappers
# ----------------------------------------------------------------------------
function Invoke-Build {
  param(
    [string]$BuildDir,
    [string]$Phase,
    [string]$ExtraArgs
  )
  Write-Host "[build] CMake (Phase $Phase)..." -ForegroundColor Cyan
  $cmakeCmd = "cmake -G Ninja -B `"$BuildDir`" -S `"$WASM_SRC`" -DCMAKE_TOOLCHAIN_FILE=`"$TC_FILE`" -DCMAKE_CROSSCOMPILING_EMULATOR=`"$NODE_EXEC`" -DCMAKE_BUILD_TYPE=Release $ExtraArgs"
  Write-Host "[build]   $cmakeCmd" -ForegroundColor DarkGray
  $cmakeProc = Start-Process -FilePath cmd -ArgumentList "/c",$cmakeCmd -NoNewWindow -Wait -PassThru
  if ($cmakeProc.ExitCode -ne 0) { throw "cmake configure failed (Phase $Phase)" }

  Write-Host "[build] Ninja (Phase $Phase)..." -ForegroundColor Cyan
  $buildBat = Join-Path $env:TEMP "build_phase${Phase}.bat"
  "@echo off`ncd /d `"$WASM_SRC`"`npython `"$EMSCRIPTEN\emmake.py`" ninja -C `"$BuildDir`" -j4`n" | Set-Content -Path $buildBat -Encoding ASCII
  $ninjaProc = Start-Process -FilePath cmd -ArgumentList "/c",$buildBat -NoNewWindow -Wait -PassThru
  Remove-Item $buildBat -Force -ErrorAction SilentlyContinue
  if ($ninjaProc.ExitCode -ne 0) { throw "ninja build failed (Phase $Phase)" }
}

function Assert-Output {
  param([string]$JsPath, [string]$WasmPath, [string]$Label)
  if (-not (Test-Path $JsPath))   { throw "${Label}: JS output missing: $JsPath" }
  if (-not (Test-Path $WasmPath)) { throw "${Label}: WASM output missing: $WasmPath" }
  $jsSize = (Get-Item $JsPath).Length
  $wasmSize = (Get-Item $WasmPath).Length
  Write-Host "[build]   ${Label} JS   : $JsPath ($jsSize bytes)" -ForegroundColor Green
  Write-Host "[build]   ${Label} WASM : $WasmPath ($wasmSize bytes)" -ForegroundColor Green
}

# ----------------------------------------------------------------------------
# Phase 0: smoke test (dummy_main.cpp)
# ----------------------------------------------------------------------------
if ($Phase -eq 0) {
  Invoke-Build -BuildDir $BUILD0_DIR -Phase 0 -ExtraArgs "-DABC_PHASE=0"
  Assert-Output -JsPath (Join-Path $BUILD0_DIR "alembic.js") `
                -WasmPath (Join-Path $BUILD0_DIR "alembic.wasm") `
                -Label "Phase 0"
}

# ----------------------------------------------------------------------------
# Phase 1: Alembic loader wasm (alembic_glue.cpp)
# ----------------------------------------------------------------------------
if ($Phase -eq 1) {
  Invoke-Build -BuildDir $BUILD1_DIR -Phase 1 -ExtraArgs "-DABC_PHASE=1"
  Assert-Output -JsPath (Join-Path $BUILD1_DIR "alembic.js") `
                -WasmPath (Join-Path $BUILD1_DIR "alembic.wasm") `
                -Label "Phase 1"
}

# ----------------------------------------------------------------------------
# Phase 2: wabc smoke test (wabc_smoke.cpp)
# ----------------------------------------------------------------------------
if ($Phase -eq 2) {
  Invoke-Build -BuildDir $BUILD2_DIR -Phase 2 -ExtraArgs "-DABC_PHASE=2"
  Assert-Output -JsPath (Join-Path $BUILD2_DIR "wabc_smoke.js") `
                -WasmPath (Join-Path $BUILD2_DIR "wabc_smoke.wasm") `
                -Label "Phase 2"
}

# ----------------------------------------------------------------------------
# Phase 3: wabc full wasm (SceneABC + wabc_js_binding)
# ----------------------------------------------------------------------------
if ($Phase -eq 3) {
  Invoke-Build -BuildDir $BUILD3_DIR -Phase 3 -ExtraArgs "-DABC_PHASE=3"
  Assert-Output -JsPath (Join-Path $BUILD3_DIR "wabc.js") `
                -WasmPath (Join-Path $BUILD3_DIR "wabc.wasm") `
                -Label "Phase 3"
}

# ----------------------------------------------------------------------------
# Vendor: copy build outputs to public/wasm/alembic/ and src-tauri/.../resources/
# ----------------------------------------------------------------------------
if ($Vendor) {
  New-Item -ItemType Directory -Force -Path $PUBLIC_DIR | Out-Null
  New-Item -ItemType Directory -Force -Path $TAURI_RES | Out-Null
  if ($Phase -eq 0) {
    Copy-Item (Join-Path $BUILD0_DIR "alembic.js")   (Join-Path $PUBLIC_DIR "alembic.js")   -Force
    Copy-Item (Join-Path $BUILD0_DIR "alembic.wasm") (Join-Path $PUBLIC_DIR "alembic.wasm") -Force
    Copy-Item (Join-Path $BUILD0_DIR "alembic.js")   (Join-Path $TAURI_RES "alembic.js")   -Force
    Copy-Item (Join-Path $BUILD0_DIR "alembic.wasm") (Join-Path $TAURI_RES "alembic.wasm") -Force
    Write-Host "[build] Vendored alembic to $PUBLIC_DIR" -ForegroundColor Green
    Write-Host "[build] Vendored alembic to $TAURI_RES" -ForegroundColor Green
  } elseif ($Phase -eq 1) {
    Copy-Item (Join-Path $BUILD1_DIR "alembic.js")   (Join-Path $PUBLIC_DIR "alembic.js")   -Force
    Copy-Item (Join-Path $BUILD1_DIR "alembic.wasm") (Join-Path $PUBLIC_DIR "alembic.wasm") -Force
    Copy-Item (Join-Path $BUILD1_DIR "alembic.js")   (Join-Path $TAURI_RES "alembic.js")   -Force
    Copy-Item (Join-Path $BUILD1_DIR "alembic.wasm") (Join-Path $TAURI_RES "alembic.wasm") -Force
    Write-Host "[build] Vendored alembic to $PUBLIC_DIR" -ForegroundColor Green
    Write-Host "[build] Vendored alembic to $TAURI_RES" -ForegroundColor Green
  } elseif ($Phase -eq 2) {
    Copy-Item (Join-Path $BUILD2_DIR "wabc_smoke.js")   (Join-Path $PUBLIC_DIR "wabc_smoke.js")   -Force
    Copy-Item (Join-Path $BUILD2_DIR "wabc_smoke.wasm") (Join-Path $PUBLIC_DIR "wabc_smoke.wasm") -Force
    Copy-Item (Join-Path $BUILD2_DIR "wabc_smoke.js")   (Join-Path $TAURI_RES "wabc_smoke.js")   -Force
    Copy-Item (Join-Path $BUILD2_DIR "wabc_smoke.wasm") (Join-Path $TAURI_RES "wabc_smoke.wasm") -Force
    Write-Host "[build] Vendored wabc_smoke to $PUBLIC_DIR" -ForegroundColor Green
    Write-Host "[build] Vendored wabc_smoke to $TAURI_RES" -ForegroundColor Green
  } elseif ($Phase -eq 3) {
    Copy-Item (Join-Path $BUILD3_DIR "wabc.js")   (Join-Path $PUBLIC_DIR "wabc.js")   -Force
    Copy-Item (Join-Path $BUILD3_DIR "wabc.wasm") (Join-Path $PUBLIC_DIR "wabc.wasm") -Force
    Copy-Item (Join-Path $BUILD3_DIR "wabc.js")   (Join-Path $TAURI_RES "wabc.js")   -Force
    Copy-Item (Join-Path $BUILD3_DIR "wabc.wasm") (Join-Path $TAURI_RES "wabc.wasm") -Force
    Write-Host "[build] Vendored wabc to $PUBLIC_DIR" -ForegroundColor Green
    Write-Host "[build] Vendored wabc to $TAURI_RES" -ForegroundColor Green
  }
}

Write-Host "[build] Done." -ForegroundColor Green
