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

.PARAMETER SkipFrontend
    Reuse the existing apps\shell\dist instead of rebuilding it (the dist is
    platform-neutral, so one built under WSL embeds fine). By DEFAULT the frontend
    is rebuilt, so the exe always embeds the latest UI — otherwise a stale dist
    silently ships old UI even though cargo rebuilt the binary.

.PARAMETER Voice
    Build and install Flux with push-to-talk voice transcription enabled. This
    still loads Vosk at runtime, so the build does not need libvosk.lib, but using
    the mic requires libvosk.dll on PATH or FLUX_VOSK_LIBRARY/FLUX_VOSK_LIB_DIR.

.NOTES
    If the repo lives on the WSL filesystem (\\wsl.localhost\...), building over
    that share works but is slow; for best results copy the repo to a local
    Windows path (e.g. C:\src\Flux) and run this from there.
#>
[CmdletBinding()]
param(
    [switch]$SkipFrontend,
    [switch]$Voice
)

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
# Rebuild by DEFAULT — a stale dist would silently ship old UI even though cargo
# rebuilt the binary (the #1 "my change didn't show up" trap). -SkipFrontend opts
# out (e.g. dist already built under WSL).
$dist = Join-Path $root 'apps\shell\dist\index.html'
if ($SkipFrontend -and (Test-Path $dist)) {
    Write-Host "==> Reusing existing apps\shell\dist (-SkipFrontend)" -ForegroundColor DarkYellow
} else {
    Need npm "Install Node >= 20 (https://nodejs.org), or pass -SkipFrontend with a prebuilt apps\shell\dist."
    # Install deps on first run AND whenever the lockfile changed since the last
    # install (e.g. a git pull that added a dependency) — npm writes
    # node_modules\.package-lock.json after each install, so compare mtimes.
    # Without this, a newly-added dep (e.g. pdfjs-dist) is missing and the vite
    # build fails to resolve it.
    $needInstall = -not (Test-Path (Join-Path $root 'node_modules'))
    $lock = Join-Path $root 'package-lock.json'
    $marker = Join-Path $root 'node_modules\.package-lock.json'
    if (-not $needInstall -and (Test-Path $lock) -and (Test-Path $marker) `
        -and (Get-Item $lock).LastWriteTimeUtc -gt (Get-Item $marker).LastWriteTimeUtc) {
        $needInstall = $true
    }
    if ($needInstall) {
        Write-Host "==> npm ci (installing/updating dependencies)" -ForegroundColor Cyan
        npm ci
    }
    Write-Host "==> Building frontend (vite)" -ForegroundColor Cyan
    npm run build --workspace apps/shell
}

# --- Release binary -----------------------------------------------------------
Write-Host "==> Building release flux.exe (LTO - takes several minutes)" -ForegroundColor Cyan
# custom-protocol -> serve the embedded frontend (without it the app loads the
# dev server URL and shows ERR_CONNECTION_REFUSED).
$features = @('custom-protocol')
if ($Voice) { $features += 'voice' }
Write-Host "==> Cargo features: $($features -join ',')" -ForegroundColor DarkCyan
cargo build --release -p flux-core --features ($features -join ',')

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
