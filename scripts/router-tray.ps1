param([switch]$TestMode)

if ($env:ROUTER_TRAY_TEST_MODE -eq "1") { $TestMode = $true }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class TrayNativeMethods {
    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr handle);
}
"@

$script:ProjectDirectory = Split-Path -Parent $PSScriptRoot
$script:EnvironmentPath = Join-Path $script:ProjectDirectory ".env"
$script:EnvironmentExamplePath = Join-Path $script:ProjectDirectory ".env.example"
$script:BotRackPath = Join-Path $script:ProjectDirectory "discord-bots.json"
$script:BotRackExamplePath = Join-Path $script:ProjectDirectory "discord-bots.example.json"
$script:ManualPath = Join-Path $script:ProjectDirectory "docs\manual.html"
$script:LogDirectory = Join-Path $script:ProjectDirectory "logs"
$script:LogPath = Join-Path $script:LogDirectory "router.log"
$configuredPort = $env:PORT
if (-not $configuredPort -and (Test-Path -LiteralPath $script:EnvironmentPath)) {
    $portLine = Get-Content -LiteralPath $script:EnvironmentPath | Where-Object { $_ -match '^\s*PORT\s*=' } | Select-Object -Last 1
    if ($portLine) { $configuredPort = (($portLine -split '=', 2)[1]).Trim().Trim('"').Trim("'") }
}
if ($configuredPort -notmatch '^\d+$' -or [int]$configuredPort -lt 1024 -or [int]$configuredPort -gt 65535) { $configuredPort = 4173 }
$script:UiUrl = "http://127.0.0.1:$configuredPort"
$script:RouterProcess = $null
$script:NodeExecutable = $null
$script:Exiting = $false
$script:FirstLaunch = $false

$createdNew = $false
$script:Mutex = New-Object System.Threading.Mutex($true, "DiscordBroadcastRouterTray", [ref]$createdNew)
if (-not $createdNew) {
    Start-Process $script:UiUrl
    $script:Mutex.Dispose()
    exit
}

New-Item -ItemType Directory -Force -Path $script:LogDirectory | Out-Null

$script:Tray = New-Object System.Windows.Forms.NotifyIcon
$script:TrayBitmap = New-Object System.Drawing.Bitmap 32, 32
$iconGraphics = [System.Drawing.Graphics]::FromImage($script:TrayBitmap)
$iconGraphics.Clear([System.Drawing.Color]::FromArgb(13, 24, 31))
$iconPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(77, 200, 232)), 2
$iconGraphics.DrawRectangle($iconPen, 2, 2, 27, 27)
$iconFont = New-Object System.Drawing.Font "Segoe UI", 7, ([System.Drawing.FontStyle]::Bold)
$iconFormat = New-Object System.Drawing.StringFormat
$iconFormat.Alignment = [System.Drawing.StringAlignment]::Center
$iconFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
$iconGraphics.DrawString("PB", $iconFont, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 0, 32, 32), $iconFormat)
$iconGraphics.Dispose()
$iconPen.Dispose()
$iconFont.Dispose()
$iconFormat.Dispose()
$script:TrayIconHandle = $script:TrayBitmap.GetHicon()
$script:Tray.Icon = [System.Drawing.Icon]::FromHandle($script:TrayIconHandle)
$script:Tray.Text = "ParaBus - 起動中"
$script:Tray.Visible = $true

function Show-Notification([string]$Title, [string]$Message, [System.Windows.Forms.ToolTipIcon]$Icon) {
    $script:Tray.ShowBalloonTip(4000, ("ParaBus - " + $Title), $Message, $Icon)
}

function Open-Ui {
    Start-Process $script:UiUrl
}

function Open-Manual {
    if (Test-CoreReady) {
        Start-Process ($script:UiUrl + "/manual")
    }
    else {
        Start-Process $script:ManualPath
    }
}

function Open-Settings {
    if (Test-CoreReady) {
        Start-Process ($script:UiUrl + "/?view=setup")
        return
    }
    if (-not (Test-Path -LiteralPath $script:EnvironmentPath)) {
        Copy-Item -LiteralPath $script:EnvironmentExamplePath -Destination $script:EnvironmentPath
    }
    Start-Process notepad.exe -ArgumentList ('"' + $script:EnvironmentPath + '"')
}

function Open-BotRackSettings {
    if (-not (Test-Path -LiteralPath $script:BotRackPath)) {
        Copy-Item -LiteralPath $script:BotRackExamplePath -Destination $script:BotRackPath
    }
    Start-Process notepad.exe -ArgumentList ('"' + $script:BotRackPath + '"')
}

function Open-Log {
    if (-not (Test-Path -LiteralPath $script:LogPath)) {
        New-Item -ItemType File -Path $script:LogPath | Out-Null
    }
    Start-Process notepad.exe -ArgumentList ('"' + $script:LogPath + '"')
}

function Test-CoreReady {
    try {
        $request = [System.Net.HttpWebRequest]::Create($script:UiUrl + "/api/state")
        $request.Timeout = 500
        $request.ReadWriteTimeout = 500
        $response = $request.GetResponse()
        $ready = [int]$response.StatusCode -eq 200
        $response.Close()
        return $ready
    }
    catch {
        return $false
    }
}

function Get-CoreState {
    try {
        return Invoke-RestMethod -Uri ($script:UiUrl + "/api/state") -TimeoutSec 1
    }
    catch {
        return $null
    }
}

function Resolve-NodeExecutable {
    # Test packages bundle Node; prefer it over any system install.
    $candidates = @(Join-Path $script:ProjectDirectory "runtime\node.exe" | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    $candidates += @((Get-Command node.exe -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source }))
    $wingetRoot = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
    if (Test-Path -LiteralPath $wingetRoot) {
        $candidates += Get-ChildItem -Path (Join-Path $wingetRoot "OpenJS.NodeJS.22_*\node-v22.*-win-x64\node.exe") -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
    }
    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        try {
            $version = & $candidate -p "process.versions.node" 2>$null
            if ($LASTEXITCODE -eq 0 -and [version]$version -ge [version]'22.23.4' -and [version]$version -lt [version]'23.0.0') { return $candidate }
        }
        catch {}
    }
    throw "Node.js 22.23.4以上23未満が見つかりません"
}

function Stop-Router {
    if ($null -eq $script:RouterProcess -or $script:RouterProcess.HasExited) {
        $script:RouterProcess = $null
        return $true
    }
    try {
        $html = (Invoke-WebRequest -UseBasicParsing -Uri $script:UiUrl -TimeoutSec 3).Content
        if ($html -notmatch 'name="dbr-session-nonce" content="([A-Za-z0-9_-]{43})"') { throw 'Session nonce unavailable' }
        $headers = @{ Origin = $script:UiUrl; 'x-dbr-session-nonce' = $Matches[1] }
        $null = Invoke-RestMethod -Uri ($script:UiUrl + '/api/shutdown') -Method Post -Headers $headers -ContentType 'application/json' -Body '{"confirmed":true}' -TimeoutSec 3
        if (-not $script:RouterProcess.WaitForExit(25000)) { throw 'Shutdown still in progress' }
    }
    catch {
        Show-Notification "終了できません" "設定ロック・障害・録音状態を確認してください。処理が応答しない場合はログを確認してください。強制終了は行っていません。" ([System.Windows.Forms.ToolTipIcon]::Warning)
        return $false
    }
    $script:RouterProcess = $null
    return $true
}

function Test-DependenciesReady {
    Add-Content -LiteralPath $script:LogPath -Value "`r`n[$(Get-Date -Format s)] Native dependency check (no device enumeration)"
    $installInfo = New-Object System.Diagnostics.ProcessStartInfo
    $installInfo.FileName = "cmd.exe"
    $installInfo.Arguments = '/d /c node.exe scripts/audio-native-check.ts >> "' + $script:LogPath + '" 2>&1 && node.exe scripts/opus-native-check.ts >> "' + $script:LogPath + '" 2>&1'
    $installInfo.WorkingDirectory = $script:ProjectDirectory
    $installInfo.UseShellExecute = $false
    $installInfo.CreateNoWindow = $true
    $installInfo.EnvironmentVariables["PATH"] = (Split-Path -Parent $script:NodeExecutable) + ";" + $env:PATH
    $install = [System.Diagnostics.Process]::Start($installInfo)
    $install.WaitForExit()
    if ($install.ExitCode -ne 0) {
        $script:Tray.Text = "ParaBus - 依存不足"
        Show-Notification "初回導入が必要です" "docs/SOURCE_RELEASE.mdの導入手順を確認してください。「ログを開く」で詳細を確認できます。起動時の自動再導入は行いません。" ([System.Windows.Forms.ToolTipIcon]::Error)
        return $false
    }
    return $true
}

function Start-Router {
    if ($null -ne $script:RouterProcess -and -not $script:RouterProcess.HasExited) {
        Open-Ui
        return
    }
    try {
        if (-not $script:NodeExecutable) { $script:NodeExecutable = Resolve-NodeExecutable }
    }
    catch {
        Add-Content -LiteralPath $script:LogPath -Value "`r`n[$(Get-Date -Format s)] $($_.Exception.Message)"
        $script:Tray.Text = "ParaBus - Node 22が必要"
        Show-Notification "修正版のNode.js 22が必要です" "Node.js 22.23.4以上23未満をインストールしてから再起動してください。" ([System.Windows.Forms.ToolTipIcon]::Error)
        return
    }
    if (-not (Test-DependenciesReady)) {
        return
    }
    $script:Tray.Text = "ParaBus - 起動中"
    Add-Content -LiteralPath $script:LogPath -Value "`r`n[$(Get-Date -Format s)] Router start"
    $processInfo = New-Object System.Diagnostics.ProcessStartInfo
    $processInfo.FileName = "cmd.exe"
    $processInfo.Arguments = '/d /c node.exe scripts/start-router.ts >> "' + $script:LogPath + '" 2>&1'
    $processInfo.WorkingDirectory = $script:ProjectDirectory
    $processInfo.UseShellExecute = $false
    $processInfo.CreateNoWindow = $true
    $processInfo.EnvironmentVariables["OPEN_BROWSER"] = "0"
    $processInfo.EnvironmentVariables["DBR_TRAY_PID"] = [string]$PID
    $processInfo.EnvironmentVariables["PATH"] = (Split-Path -Parent $script:NodeExecutable) + ";" + $env:PATH
    $script:RouterProcess = [System.Diagnostics.Process]::Start($processInfo)

    $ready = $false
    for ($attempt = 0; $attempt -lt 240; $attempt += 1) {
        if ($script:RouterProcess.HasExited) { break }
        if (Test-CoreReady) {
            $ready = $true
            break
        }
        Start-Sleep -Milliseconds 250
    }
    if ($ready) {
        $script:Tray.Text = "ParaBus - 実行中"
        Show-Notification "起動しました" "アイコンをダブルクリックすると操作画面を開きます。" ([System.Windows.Forms.ToolTipIcon]::Info)
        if ($script:FirstLaunch) {
            Show-Notification "Discord設定" "設定を入力した後、アイコンを右クリックして「再起動」を選んでください。" ([System.Windows.Forms.ToolTipIcon]::Info)
            Open-Settings
        }
    }
    else {
        $script:Tray.Text = "ParaBus - 起動失敗"
        Show-Notification "起動できませんでした" "アイコンを右クリックし、「ログを開く」で詳細を確認してください。" ([System.Windows.Forms.ToolTipIcon]::Error)
    }
}

function Restart-Router {
    $state = Get-CoreState
    if ($state -and ($state.state -eq "ON_AIR" -or $state.state -eq "FAULT" -or $state.recorder.state -ne "IDLE")) {
        Show-Notification "再起動できません" "設定ロックをOFF、障害を確認済み、録音停止にしてからSETUPで再起動してください。" ([System.Windows.Forms.ToolTipIcon]::Warning)
        Open-Settings
        return
    }
    $answer = [System.Windows.Forms.MessageBox]::Show("ParaBus本体を再起動しますか？`r`nDiscord BotとAudio I/Oはいったん切断されます。", "ParaBus", [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning)
    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    $script:Tray.Text = "ParaBus - 再起動中"
    if (-not (Stop-Router)) { return }
    Start-Sleep -Milliseconds 500
    Start-Router
}

function Exit-Router {
    if ($script:Exiting) { return }
    if (-not (Stop-Router)) { return }
    $script:Exiting = $true
    if ($null -ne $script:StatusTimer) {
        $script:StatusTimer.Stop()
        $script:StatusTimer.Dispose()
    }
    $script:Tray.Visible = $false
    $script:Tray.Dispose()
    [TrayNativeMethods]::DestroyIcon($script:TrayIconHandle) | Out-Null
    $script:TrayBitmap.Dispose()
    [System.Windows.Forms.Application]::ExitThread()
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add("UIを開く")
$manualItem = $menu.Items.Add("マニュアルを開く")
$settingsItem = $menu.Items.Add("Discord Bot設定を開く")
$botRackSettingsItem = $menu.Items.Add("設定ファイルを直接開く")
$restartItem = $menu.Items.Add("再起動")
$logItem = $menu.Items.Add("ログを開く")
$null = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$exitItem = $menu.Items.Add("終了")

$openItem.add_Click({ Open-Ui })
$manualItem.add_Click({ Open-Manual })
$settingsItem.add_Click({ Open-Settings })
$botRackSettingsItem.add_Click({ Open-BotRackSettings })
$restartItem.add_Click({ Restart-Router })
$logItem.add_Click({ Open-Log })
$exitItem.add_Click({ Exit-Router })
$script:Tray.add_DoubleClick({ Open-Ui })
$script:Tray.ContextMenuStrip = $menu

if (-not $TestMode -and -not (Test-Path -LiteralPath $script:EnvironmentPath)) {
    Copy-Item -LiteralPath $script:EnvironmentExamplePath -Destination $script:EnvironmentPath
    $script:FirstLaunch = $true
}

$script:StatusTimer = New-Object System.Windows.Forms.Timer
$script:StatusTimer.Interval = 1000
$script:StatusTimer.add_Tick({
    if ($null -ne $script:RouterProcess -and $script:RouterProcess.HasExited -and -not $script:Exiting) {
        if ($script:RouterProcess.ExitCode -eq 0) { Exit-Router; return }
        $script:Tray.Text = "ParaBus - 停止中"
    }
})
$script:StatusTimer.Start()

Start-Router
if ($TestMode) {
    $testSucceeded = Test-CoreReady
    Stop-Router
    $script:Tray.Visible = $false
    $script:Tray.Dispose()
    [TrayNativeMethods]::DestroyIcon($script:TrayIconHandle) | Out-Null
    $script:TrayBitmap.Dispose()
    $script:Mutex.ReleaseMutex()
    $script:Mutex.Dispose()
    if ($testSucceeded) { exit 0 }
    exit 1
}
[System.Windows.Forms.Application]::Run()

if (-not $script:Exiting) { Exit-Router }
$script:Mutex.ReleaseMutex()
$script:Mutex.Dispose()
