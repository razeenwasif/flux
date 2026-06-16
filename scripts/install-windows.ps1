#requires -Version 5
<#
.SYNOPSIS
    Build Flux and install the `flux` command on Windows (the WebView2 build).

.DESCRIPTION
    Produces a self-contained flux.exe (the SolidJS frontend is embedded at build
    time) and copies it to %USERPROFILE%\.cargo\bin - already on PATH for rustup
    installs -so `flux` runs from any directory or terminal.

    Prerequisites:
      * Rust (rustup) with the x86_64-pc-windows-msvc toolchain
        (rustup default stable-msvc).
      * MSVC C++ build tools: Visual Studio 2022 or the standalone Build Tools
        with the "Desktop development with C++" workload (provides link.exe).
        This is the piece most often missing -installing just the Windows SDK
        is NOT enough. One-liner:
          winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override `
            "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
      * WebView2 Runtime (preinstalled on current Win10/11; otherwise
        winget install Microsoft.EdgeWebView2Runtime).
      * Node >= 20 + npm -only needed if the frontend must be (re)built.

.PARAMETER Frontend
    Force a fresh frontend build (npm ci + vite). Otherwise an existing
    apps\shell\dist is reused -it's platform-neutral, so a dist built under
    WSL/Linux embeds fine into the Windows binary.

.NOTES
    If the repo lives on the WSL filesystem (\\wsl.localhost\...), building over
    that share works but is slow; for best results copy the repo to a local
    Windows path (e.g. C:\src\Flux) and run this from there.
#>
[CmdletBinding()]
param([switch]$Frontend)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Write-Host "Flux repo: $root" -ForegroundColor Cyan

function Need($cmd, $hint) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "Missing '$cmd'. $hint" }
}

# --- Toolchain checks ---------------------------------------------------------
Need cargo "Install Rust from https://rustup.rs then: rustup default stable-msvc"

# MSVC linker (link.exe) via vswhere -the prerequisite most often missing.
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$hasVC = $false
if (Test-Path $vswhere) {
    $vc = & $vswhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath 2>$null
    if ($vc) { $hasVC = $true }
}
if (-not $hasVC) {
    throw @"
MSVC C++ build tools (link.exe) were not found - the build cannot link without them.
Install the 'Desktop development with C++' workload, e.g.:

  winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override `
    "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

Then re-run this script from a NEW terminal.
"@
}

# --- Frontend (embedded into the exe at build time) ---------------------------
$dist = Join-Path $root 'apps\shell\dist\index.html'
if ($Frontend -or -not (Test-Path $dist)) {
    Need npm "Install Node >= 20 (https://nodejs.org), or provide a prebuilt apps\shell\dist."
    Write-Host "==> Building frontend (npm ci + vite)" -ForegroundColor Cyan
    npm ci
    npm run build --workspace apps/shell
} else {
    Write-Host "==> Reusing existing apps\shell\dist (pass -Frontend to rebuild)" -ForegroundColor DarkYellow
}

# --- Release binary -----------------------------------------------------------
Write-Host "==> Building release flux.exe (LTO - takes several minutes)" -ForegroundColor Cyan
cargo build --release -p flux-core

$exe = Join-Path $root 'target\release\flux.exe'
if (-not (Test-Path $exe)) { throw "Build reported success but $exe is missing." }

# --- Install onto PATH --------------------------------------------------------
$dest = Join-Path $env:USERPROFILE '.cargo\bin'
if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Force -Path $dest | Out-Null }
Copy-Item $exe (Join-Path $dest 'flux.exe') -Force
Write-Host "==> Installed: $dest\flux.exe" -ForegroundColor Green

# rustup usually has .cargo\bin on PATH already; add it if not.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$dest*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$dest", 'User')
    Write-Host "Added $dest to your user PATH - open a new terminal to pick it up." -ForegroundColor Yellow
}

Write-Host "`nDone. Open a new terminal and run:  flux --version" -ForegroundColor Green
