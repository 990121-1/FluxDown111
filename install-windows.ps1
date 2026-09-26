#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Programs\FluxDown"),
    [ValidateSet("Chrome", "Edge", "Both", "None")]
    [string]$Browser = "Chrome",
    [switch]$SkipPrerequisites,
    [switch]$Clean,
    [switch]$NoLaunch,
    [switch]$NoShortcuts
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step { param([string]$Message) Write-Host ""; Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok { param([string]$Message) Write-Host "[OK] $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "[!] $Message" -ForegroundColor Yellow }

function Refresh-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $extra = @((Join-Path $env:USERPROFILE ".cargo\bin"), "$env:ProgramFiles\nodejs")
    $env:Path = (($machine, $user) + $extra | Where-Object { $_ }) -join ";"
}

function Get-Executable {
    param([Parameter(Mandatory)][string[]]$Names)
    foreach ($name in $Names) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    }
    return $null
}

function Invoke-Native {
    param([Parameter(Mandatory)][string]$File, [Parameter(ValueFromRemainingArguments)][string[]]$Arguments)
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $File $($Arguments -join ' ')" }
}

function Require-Winget {
    $winget = Get-Executable @("winget.exe", "winget")
    if (-not $winget) {
        throw "A prerequisite is missing and winget is unavailable. Install 'App Installer' from Microsoft Store, then run this script again."
    }
    return $winget
}

function Install-WingetPackage {
    param([Parameter(Mandatory)][string]$Id, [Parameter(Mandatory)][string]$Label, [string]$Override = "")
    $winget = Require-Winget
    Write-Step "Installing $Label"
    $args = @("install", "--id", $Id, "--exact", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements", "--silent")
    if ($Override) { $args += @("--override", $Override) }
    & $winget @args
    if ($LASTEXITCODE -ne 0) { throw "winget could not install $Label ($Id). Exit code: $LASTEXITCODE" }
    Refresh-ProcessPath
}

function Test-Msvc {
    if (Get-Executable @("cl.exe", "cl")) { return $true }
    $vswhereCandidates = @(
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe",
        "$env:ProgramFiles\Microsoft Visual Studio\Installer\vswhere.exe"
    )
    foreach ($vswhere in $vswhereCandidates) {
        if (-not (Test-Path -LiteralPath $vswhere)) { continue }
        $installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if ($LASTEXITCODE -eq 0 -and $installation) { return $true }
    }
    return $false
}

function Ensure-Prerequisites {
    Write-Step "Checking prerequisites"
    Refresh-ProcessPath

    if (-not (Get-Executable @("cargo.exe", "cargo"))) {
        Install-WingetPackage -Id "Rustlang.Rustup" -Label "Rust / rustup"
    }
    Refresh-ProcessPath

    $rustup = Get-Executable @("rustup.exe", "rustup")
    $cargo = Get-Executable @("cargo.exe", "cargo")
    $rustc = Get-Executable @("rustc.exe", "rustc")
    if (-not $rustup -or -not $cargo -or -not $rustc) { throw "Rust installation was not found after setup." }

    Invoke-Native $rustup "default" "stable"
    Write-Ok "Rust: $(& $rustc --version)"

    if (-not (Get-Executable @("node.exe", "node")) -or -not (Get-Executable @("npm.cmd", "npm"))) {
        Install-WingetPackage -Id "OpenJS.NodeJS.LTS" -Label "Node.js LTS"
    }
    Refresh-ProcessPath

    $node = Get-Executable @("node.exe", "node")
    $npm = Get-Executable @("npm.cmd", "npm")
    if (-not $node -or -not $npm) { throw "Node.js/npm installation was not found after setup." }

    Write-Ok "Node: $(& $node --version)"
    Write-Ok "npm: $(& $npm --version)"

    if (-not (Test-Msvc)) {
        Write-Warn "MSVC C++ Build Tools not found. Installing Visual Studio Build Tools 2022..."
        Install-WingetPackage -Id "Microsoft.VisualStudio.2022.BuildTools" -Label "Visual Studio Build Tools (C++)" -Override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    }
    if (-not (Test-Msvc)) { throw "MSVC C++ Build Tools are still unavailable. Reboot Windows once, then rerun this script." }

    Write-Ok "MSVC C++ Build Tools detected"
}

function Stop-FluxDownProcesses {
    Write-Step "Stopping running FluxDown processes"
    foreach ($name in @("fluxdown-desktop", "fluxdown-agent", "fluxdownd", "fluxdown_nmh")) {
        Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 700
}

function New-Shortcut {
    param([Parameter(Mandatory)][string]$ShortcutPath, [Parameter(Mandatory)][string]$TargetPath, [Parameter(Mandatory)][string]$WorkingDirectory)
    $parent = Split-Path -Parent $ShortcutPath
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($ShortcutPath)
    $shortcut.TargetPath = $TargetPath
    $shortcut.WorkingDirectory = $WorkingDirectory
    $shortcut.IconLocation = "$TargetPath,0"
    $shortcut.Description = "FluxDown Download Manager"
    $shortcut.Save()
}

function Find-BrowserExe {
    param([ValidateSet("Chrome", "Edge")][string]$Name)
    if ($Name -eq "Chrome") {
        $candidates = @(
            "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
            "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
            "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
        )
    } else {
        $candidates = @(
            "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
            "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
            "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
        )
    }
    return ($candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1)
}

function Open-ExtensionPage {
    param([ValidateSet("Chrome", "Edge")][string]$Name, [string]$ExtensionDir)
    $exe = Find-BrowserExe -Name $Name
    if (-not $exe) { Write-Warn "$Name was not found; skipping browser extension page."; return }
    $url = if ($Name -eq "Chrome") { "chrome://extensions" } else { "edge://extensions" }
    Start-Process -FilePath $exe -ArgumentList $url
    Write-Host "Open $Name -> enable Developer mode -> Load unpacked -> select:"
    Write-Host "  $ExtensionDir" -ForegroundColor Yellow
}

if ($env:OS -ne "Windows_NT") { throw "This installer is for Windows only." }

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoRoot

if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "Cargo.toml"))) { throw "Cargo.toml not found. Run this script from a cloned FluxDown111 repository." }
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "fluxDown\package.json"))) { throw "fluxDown/package.json not found. Repository checkout is incomplete." }

Write-Host ""
Write-Host "FluxDown Windows one-click build/install" -ForegroundColor White
Write-Host "Repository : $RepoRoot"
Write-Host "Install dir: $InstallDir"
Write-Host ""

if (-not $SkipPrerequisites) { Ensure-Prerequisites }
else { Write-Warn "Skipping prerequisite installation/check by request."; Refresh-ProcessPath }

$cargo = Get-Executable @("cargo.exe", "cargo")
$npm = Get-Executable @("npm.cmd", "npm")
if (-not $cargo) { throw "cargo not found." }
if (-not $npm) { throw "npm not found." }

if ($Clean) {
    Write-Step "Cleaning previous local build outputs"
    Remove-Item -LiteralPath (Join-Path $RepoRoot "target") -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $RepoRoot "fluxDown\.output") -Recurse -Force -ErrorAction SilentlyContinue
}

Stop-FluxDownProcesses

Write-Step "Building FluxDown Windows release binaries"
$cargoArgs = @(
    "build", "--release", "--locked",
    "-p", "fluxdown_ui_app",
    "-p", "fluxdown_agent",
    "-p", "fluxdown_daemon",
    "-p", "fluxdown_nmh",
    "--bins"
)
Invoke-Native $cargo @cargoArgs

Write-Step "Installing browser-extension dependencies"
Push-Location (Join-Path $RepoRoot "fluxDown")
try {
    Invoke-Native $npm "install" "--package-lock=false"
    Write-Step "Building Chrome/Edge MV3 extension"
    Invoke-Native $npm "run" "build"
} finally {
    Pop-Location
}

$ReleaseDir = Join-Path $RepoRoot "target\release"
$ExtensionBuildDir = Join-Path $RepoRoot "fluxDown\.output\chrome-mv3"
$RequiredExe = @("fluxdown-desktop.exe", "fluxdown-agent.exe", "fluxdownd.exe", "fluxdown_nmh.exe")

foreach ($exeName in $RequiredExe) {
    $source = Join-Path $ReleaseDir $exeName
    if (-not (Test-Path -LiteralPath $source)) { throw "Build output missing: $source" }
}
if (-not (Test-Path -LiteralPath (Join-Path $ExtensionBuildDir "manifest.json"))) { throw "Extension build output missing: $ExtensionBuildDir" }

Write-Step "Installing FluxDown into $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
foreach ($exeName in $RequiredExe) {
    Copy-Item -LiteralPath (Join-Path $ReleaseDir $exeName) -Destination (Join-Path $InstallDir $exeName) -Force
}

$InstalledExtensionDir = Join-Path $InstallDir "extension"
Remove-Item -LiteralPath $InstalledExtensionDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $InstalledExtensionDir | Out-Null
Copy-Item -Path (Join-Path $ExtensionBuildDir "*") -Destination $InstalledExtensionDir -Recurse -Force

$DesktopExe = Join-Path $InstallDir "fluxdown-desktop.exe"

if (-not $NoShortcuts) {
    Write-Step "Creating shortcuts"
    $desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "FluxDown.lnk"
    $startMenuShortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\FluxDown.lnk"
    New-Shortcut -ShortcutPath $desktopShortcut -TargetPath $DesktopExe -WorkingDirectory $InstallDir
    New-Shortcut -ShortcutPath $startMenuShortcut -TargetPath $DesktopExe -WorkingDirectory $InstallDir
    Write-Ok "Desktop and Start Menu shortcuts created"
}

if (-not $NoLaunch) {
    Write-Step "Starting FluxDown"
    Start-Process -FilePath $DesktopExe -WorkingDirectory $InstallDir

    $manifest = Join-Path $env:LOCALAPPDATA "FluxDown\nmh\com.fluxdown.nmh.json"
    $deadline = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $manifest)) { Start-Sleep -Milliseconds 500 }

    if (Test-Path -LiteralPath $manifest) { Write-Ok "Native Messaging manifest registered" }
    else { Write-Warn "FluxDown started, but Native Messaging manifest was not observed within 25 seconds." }
}

try { Set-Clipboard -Value $InstalledExtensionDir; Write-Ok "Extension folder path copied to clipboard" }
catch { Write-Warn "Could not copy extension path to clipboard." }

if ($Browser -in @("Chrome", "Both")) { Open-ExtensionPage -Name "Chrome" -ExtensionDir $InstalledExtensionDir }
if ($Browser -in @("Edge", "Both")) { Open-ExtensionPage -Name "Edge" -ExtensionDir $InstalledExtensionDir }

$summaryPath = Join-Path $InstallDir "INSTALL_COMPLETE.txt"
$summary = @"
FluxDown installation completed.

Desktop EXE:
$DesktopExe

Browser extension folder:
$InstalledExtensionDir

Chrome:
1. Open chrome://extensions
2. Enable Developer mode
3. Click Load unpacked
4. Select the extension folder above

Edge:
1. Open edge://extensions
2. Enable Developer mode
3. Click Load unpacked
4. Select the extension folder above
"@
$summary | Set-Content -LiteralPath $summaryPath -Encoding UTF8

Write-Host ""
Write-Host "==============================================" -ForegroundColor Green
Write-Host " FluxDown build/install completed successfully " -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor Green
Write-Host ""
Write-Host "Desktop EXE:"
Write-Host "  $DesktopExe" -ForegroundColor Yellow
Write-Host ""
Write-Host "Browser extension:"
Write-Host "  $InstalledExtensionDir" -ForegroundColor Yellow
Write-Host ""
Write-Host "The extension path is also in your clipboard."
Write-Host "After Chrome/Edge opens, click 'Load unpacked' and select that folder."
Write-Host ""
