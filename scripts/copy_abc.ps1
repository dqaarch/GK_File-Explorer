$src = "C:\Users\Mabu02\Downloads\Sample 3D\RunningCharacter.abc"
$dst = "F:\Goku File Explorer Light\public\RunningCharacter.abc"
[System.IO.File]::Copy($src, $dst, $true)
Get-ChildItem $dst | Select-Object Length