$src = "f:\Goku File Explorer Light\src\hooks\useFontPreview.ts"
$temp = "f:\Goku File Explorer Light\src\hooks\useFontPreview.ts.tmp"
$content = Get-Content -Path $src -Raw -Encoding Unicode
[System.IO.File]::WriteAllText($temp, $content, [System.Text.Encoding]::UTF8)
Move-Item -Path $temp -Destination $src -Force
Write-Host "Converted to UTF-8"
