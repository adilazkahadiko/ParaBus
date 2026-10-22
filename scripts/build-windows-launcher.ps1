param([string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows build host required' }
$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vsPath = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) { throw 'Visual Studio C++ build tools are required' }
& (Join-Path $vsPath 'Common7/Tools/Launch-VsDevShell.ps1') -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
Get-Command rc.exe, cargo.exe -ErrorAction Stop | Out-Null
$build = Join-Path $ProjectRoot 'target/windows-launcher'
New-Item -ItemType Directory -Force -Path $build | Out-Null

# Reuse the tray's PB artwork via Windows' built-in drawing/RC tools, no crates.
Add-Type -AssemblyName System.Drawing
Add-Type 'public static class LauncherIconNative { [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool DestroyIcon(System.IntPtr handle); }'
$bitmap = New-Object Drawing.Bitmap 32, 32
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([Drawing.Color]::FromArgb(13, 24, 31))
$pen = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(77, 200, 232)), 2
$font = New-Object Drawing.Font 'Segoe UI', 10, ([Drawing.FontStyle]::Bold)
$graphics.DrawRectangle($pen, 2, 2, 27, 27)
$graphics.DrawString('PB', $font, [Drawing.Brushes]::White, 4, 7)
$handle = $bitmap.GetHicon()
$icon = [Drawing.Icon]::FromHandle($handle)
$file = [IO.File]::Create((Join-Path $build 'ParaBus.ico'))
try { $icon.Save($file) } finally {
    $file.Dispose(); $icon.Dispose(); [LauncherIconNative]::DestroyIcon($handle) | Out-Null
    $graphics.Dispose(); $bitmap.Dispose(); $pen.Dispose(); $font.Dispose()
}
Set-Content -LiteralPath (Join-Path $build 'ParaBus.rc') -Value '1 ICON "ParaBus.ico"' -Encoding ascii
Push-Location $build
try { & rc.exe /nologo /fo ParaBus.res ParaBus.rc; if ($LASTEXITCODE -ne 0) { throw 'Icon resource compilation failed' } }
finally { Pop-Location }
Push-Location $ProjectRoot
try {
    & cargo.exe rustc --locked --release -p parabus-launcher --bin ParaBus -- -C "link-arg=$(Join-Path $build 'ParaBus.res')"
    if ($LASTEXITCODE -ne 0) { throw 'ParaBus.exe compilation failed' }
} finally { Pop-Location }
