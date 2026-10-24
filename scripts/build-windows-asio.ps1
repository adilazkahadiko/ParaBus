# Run only in a stopped / isolated dependency tree. CI invokes this before packaging.
# The fixed SDK is used under its GPLv3 option; no manufacturer driver is installed.
param([string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows x64 build host required' }
$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
if ((& $nodeExecutable -p "process.platform + '/' + process.arch") -ne 'win32/x64') { throw 'Use Windows x64 Node.js' }
$moduleRoot = Join-Path $ProjectRoot 'node_modules/naudiodon2'
if ((Get-Content (Join-Path $moduleRoot 'package.json') -Raw | ConvertFrom-Json).version -ne '2.5.0') { throw 'Expected locked naudiodon2 2.5.0' }
$nodeGyp = Join-Path $ProjectRoot 'node_modules/node-gyp/bin/node-gyp.js'
if (-not (Test-Path -LiteralPath $nodeGyp -PathType Leaf)) { throw 'Install the locked build dependencies first' }
$buildRoot = Join-Path $ProjectRoot 'target/windows-asio'
if (Test-Path -LiteralPath $buildRoot) { throw 'Choose a fresh dependency tree; target/windows-asio already exists' }
New-Item -ItemType Directory -Path $buildRoot | Out-Null

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vsPath = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) { throw 'Visual Studio C++ build tools are required' }
& (Join-Path $vsPath 'Common7/Tools/Launch-VsDevShell.ps1') -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
Get-Command git.exe, cmake.exe, ninja.exe, dumpbin.exe -ErrorAction Stop | Out-Null

$portAudioCommit = '17967f32de95f2179e7f7caa9632a79c5d59a2ea'
$sdkUrl = 'https://download.steinberg.net/sdk_downloads/ASIO-SDK_2.3.4_2025-10-15.zip'
$sdkHash = 'd5ebf0c20dd2c5f43771fd0c1418f4b361bf52434ee670097cfa6b3a335e2eca'
$sdkLicenseHash = '61e56814f24b32216884b2db0b4dcc317111a5ab354d54d19dd9fc13d71b1c7a'
$sdkZip = Join-Path $buildRoot 'asiosdk.zip'
Invoke-WebRequest -Uri $sdkUrl -OutFile $sdkZip -TimeoutSec 120
if ((Get-FileHash -LiteralPath $sdkZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sdkHash) { throw 'ASIO SDK checksum mismatch; do not substitute an unreviewed SDK' }
$source = Join-Path $buildRoot 'portaudio'
git.exe init $source
if ($LASTEXITCODE -ne 0) { throw 'PortAudio init failed' }
git.exe -C $source fetch --depth 1 https://github.com/PortAudio/portaudio.git $portAudioCommit
if ($LASTEXITCODE -ne 0) { throw 'PortAudio fetch failed' }
git.exe -C $source checkout --detach FETCH_HEAD
if ($LASTEXITCODE -ne 0 -or (& git.exe -C $source rev-parse HEAD) -ne $portAudioCommit) { throw 'PortAudio commit mismatch' }

$build = Join-Path $buildRoot 'build'
$cmakeArguments = @(
    '-S', $source, '-B', $build, '-G', 'Ninja',
    '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_RELEASE_POSTFIX=_x64',
    '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded',
    '-DPA_BUILD_SHARED_LIBS=ON', '-DPA_USE_ASIO=ON', '-DPA_USE_WASAPI=ON',
    '-DPA_BUILD_EXAMPLES=OFF', '-DPA_BUILD_TESTS=OFF',
    "-DASIO_SDK_ZIP_PATH=$($sdkZip.Replace('\', '/'))"
)
$configureLog = @(& cmake.exe @cmakeArguments 2>&1)
$configureExit = $LASTEXITCODE
$configureLog | ForEach-Object { Write-Host $_ }
if ($configureExit -ne 0 -or -not ($configureLog -match 'Found ASIO SDK:') -or ($configureLog -match 'Downloading ASIO SDK')) { throw 'CMake did not use the pinned SDK' }
$sdkRoot = Join-Path $build 'ASIOSDK'
if ((Get-FileHash -LiteralPath (Join-Path $sdkRoot 'LICENSE.txt') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sdkLicenseHash) { throw 'ASIO SDK license mismatch' }
$graph = Get-Content -LiteralPath (Join-Path $build 'build.ninja') -Raw
foreach ($part in @('pa_asio.cpp.obj', 'common/asio.cpp.obj', 'host/asiodrivers.cpp.obj', 'host/pc/patched_asiolist.cpp.obj')) {
    if (-not $graph.Replace('\', '/').Contains($part)) { throw "Missing ASIO compile input: $part" }
}
& cmake.exe --build $build --target portaudio --parallel 2
if ($LASTEXITCODE -ne 0) { throw 'PortAudio ASIO build failed' }
$dll = Join-Path $build 'portaudio_x64.dll'
$lib = Join-Path $build 'portaudio_x64.lib'
foreach ($file in @($dll, $lib)) { if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing build output: $file" } }
$exports = @(& dumpbin.exe /exports $dll)
if ($LASTEXITCODE -ne 0 -or -not ($exports -match 'PaAsio_GetAvailableBufferSizes')) { throw 'Built DLL lacks ASIO exports' }

# Re-link against this exact import library: do not assume old vendor DLL ordinals match.
# CMAKE_RELEASE_POSTFIX gives both the DLL and its import library the expected _x64 name.
Copy-Item -LiteralPath $dll, $lib -Destination (Join-Path $moduleRoot 'portaudio/bin') -Force
Copy-Item -LiteralPath (Join-Path $source 'include/portaudio.h') -Destination (Join-Path $moduleRoot 'portaudio/include/portaudio.h') -Force
Push-Location $moduleRoot
try {
    & $nodeExecutable $nodeGyp rebuild --release --arch=x64
    if ($LASTEXITCODE -ne 0) { throw 'naudiodon2 ASIO re-link failed' }
} finally { Pop-Location }
$installedDll = Join-Path $moduleRoot 'build/Release/portaudio_x64.dll'
if ((Get-FileHash -LiteralPath $installedDll).Hash -ne (Get-FileHash -LiteralPath $dll).Hash) { throw 'Native build copied a different PortAudio DLL' }

# Keep all corresponding build inputs alongside this private test binary, without .git.
$bundle = Join-Path $buildRoot 'source-bundle'
New-Item -ItemType Directory -Path $bundle | Out-Null
$portAudioSourceZip = Join-Path $bundle 'portaudio-source.zip'
git.exe -C $source archive --format=zip "--output=$portAudioSourceZip" $portAudioCommit
if ($LASTEXITCODE -ne 0) { throw 'PortAudio source archive failed' }
Copy-Item -LiteralPath $sdkZip -Destination (Join-Path $bundle 'asiosdk.zip')
Copy-Item -LiteralPath (Join-Path $sdkRoot 'host/pc/patched_asiolist.cpp') -Destination (Join-Path $bundle 'patched_asiolist.cpp')
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'LICENSE') -Destination (Join-Path $bundle 'COPYING-GPL-3.0')
$metadata = [ordered]@{
    schemaVersion = 1
    portAudioCommit = $portAudioCommit
    sdkUrl = $sdkUrl
    sdkSha256 = $sdkHash
    sdkLicenseSha256 = $sdkLicenseHash
    sdkLicenseChoice = 'GPL-3.0-only'
    configuration = 'Release x64 ASIO + WASAPI; MSVC static runtime; matching import library'
    node = (& $nodeExecutable -p 'process.version')
    dllSha256 = (Get-FileHash -LiteralPath $installedDll -Algorithm SHA256).Hash.ToLowerInvariant()
    bindingSha256 = (Get-FileHash -LiteralPath (Join-Path $moduleRoot 'build/Release/naudiodon.node') -Algorithm SHA256).Hash.ToLowerInvariant()
    portAudioSourceSha256 = (Get-FileHash -LiteralPath (Join-Path $bundle 'portaudio-source.zip') -Algorithm SHA256).Hash.ToLowerInvariant()
    patchedAsioListSha256 = (Get-FileHash -LiteralPath (Join-Path $bundle 'patched_asiolist.cpp') -Algorithm SHA256).Hash.ToLowerInvariant()
}
$metadata | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $moduleRoot 'asio-build-info.json') -Encoding utf8NoBOM
Copy-Item -LiteralPath (Join-Path $moduleRoot 'asio-build-info.json') -Destination $bundle
Get-Content -LiteralPath (Join-Path $ProjectRoot 'docs/ASIO_PACKAGE.txt') -Raw -Encoding utf8 | Set-Content -LiteralPath (Join-Path $bundle 'README-ASIO.txt') -Encoding utf8NoBOM
