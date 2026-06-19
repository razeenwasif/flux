# Startup profiling on Windows

Use this when Flux feels slow to launch. The WSL build is WebKitGTK and is not
representative of the Windows WebView2 path, so collect startup numbers from a
native Windows checkout such as `C:\src\Flux`.

## Build the profiled binary

From a native Windows PowerShell:

```powershell
git rev-parse --short HEAD
.\scripts\install-windows.ps1
```

For repeatable measurements, build and run from a local NTFS path. Building or
launching from `\\wsl.localhost\...` adds filesystem latency that is unrelated to
Flux.

## Quick boot-phase timing

Flux logs setup phases under the `flux::boot` tracing target. These timings show
which Rust setup step is delaying the window path.

```powershell
$env:RUST_LOG = "flux::boot=info,flux=warn"
$log = "$PWD\flux-boot.log"
& "$env:USERPROFILE\.cargo\bin\flux.exe" 2>&1 | Tee-Object $log
```

Close the Flux window after it appears, then extract the boot lines:

```powershell
Select-String "flux::boot" .\flux-boot.log
```

Look for:

| Field | Meaning |
|---|---|
| `phase` | Setup step name, for example `session.restore` or `archive.hydrate` |
| `elapsed_ms` | Time spent in that phase |
| `total_ms` | Time since Tauri setup started |
| `state managed, window up` | Final setup log; use its `total_ms` as the Rust setup number |

Run it twice: first after a reboot or long idle for a cold-ish run, then again
after closing Flux for a warm run. Keep both logs; antivirus, WebView2 cache, and
Windows Credential Manager can make cold and warm launches differ materially.

## ETW trace with Windows Performance Recorder

Use this when the boot log says Rust setup is fast but the exe still takes a long
time to show a window. ETW captures loader, CPU, disk, Defender, WebView2, and DWM
activity outside Flux.

1. Install Windows Performance Toolkit:

```powershell
winget install --id Microsoft.WindowsPerformanceToolkit -e
```

2. Start a trace, launch Flux, wait until the window is visible, close Flux, then
stop the trace:

```powershell
wpr -start GeneralProfile -filemode
Start-Process "$env:USERPROFILE\.cargo\bin\flux.exe"
# wait until the first Flux window is visible, then close it
wpr -stop "$PWD\flux-startup.etl"
```

3. Open the trace:

```powershell
wpa "$PWD\flux-startup.etl"
```

In WPA, start with these views:

| View | What to check |
|---|---|
| CPU Usage (Sampled) | `flux.exe` hot functions during startup |
| Disk Usage | slow reads under app data, `target`, or WebView2 cache paths |
| Generic Events / Process Lifetime | process start timing and WebView2 child process creation |
| Defender / AntiMalware events, if present | scanning delays on `flux.exe`, app data, or the repo |

## Report template

Record these with each startup report:

```text
Flux commit:
Build command:
Windows version:
CPU / RAM / disk:
Repo path:
Installed exe path:
Cold run boot log:
Warm run boot log:
Notable ETW findings:
```

Also include whether Windows Defender or another antivirus was actively scanning
the repo or `flux.exe`. If a slow run only happens from a WSL share path, move the
repo to a local Windows path before treating it as a Flux regression.
