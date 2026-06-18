# Memory benchmark — Flux vs Chrome (the low-RAM wedge)

Flux's headline claim is **"lighter than Chrome."** This doc makes that a
*number you can cite*, and a procedure anyone can rerun. It complements the
artifact gates in [`scripts/perf-budget.mjs`](../../scripts/perf-budget.mjs)
(chrome JS ≤ 50 KB gzip, binary ≤ 25 MB — checked in CI on every PR) by covering
the budgets that need a running window: **idle RAM** and **RAM under N tabs**
(ADR 0001).

> Why this isn't in CI: idle/under-load RSS needs the real OS webview
> (WebView2 / WebKitGTK) and a display. GitHub's hosted runners have neither in
> a representative way, so this is a **self-hosted-runner / manual** gate. The
> artifact budgets *are* gated automatically.

## What we measure

**Resident set of the entire browser process tree** — not one process. Both
Flux and Chrome spawn helper/renderer processes; a fair comparison sums them
all. We exclude the local LLM (Ollama runs as a separate service for both the
agent and, if you point Chrome at a local model extension, in principle for it
too) so we're comparing *browser* footprint, not model weights.

Three load points:

| Scenario | Tabs |
|---|---|
| Idle | empty shell, 0 web tabs, 60 s after launch |
| Light | 10 tabs from the fixed set below |
| Heavy | 30 tabs (the set ×3) |

Settle for **60 s** after the last tab finishes loading before sampling (lets
caches/GC settle). Sample 3× at 10 s intervals; record the median.

### Fixed tab set (10)

Keep this stable so runs are comparable across versions:

```
https://en.wikipedia.org/wiki/Web_browser
https://news.ycombinator.com
https://github.com/trending
https://www.nytimes.com
https://stackoverflow.com/questions
https://www.reddit.com/r/programming
https://www.youtube.com
https://docs.rs/tokio
https://www.amazon.com
https://maps.google.com
```

## How to sample RSS

### Flux

Open **`flux://tasks`** (the built-in task manager, ⌘K → "Open Task manager").
It walks Flux's own process tree (by parent pid, not name) and reports resident
MiB per process — sum the rows marked as Flux's tree, or read the total. This is
the same `sysinfo` data the resource governor (`flux://resources`) uses.

### Chrome / Edge

Chrome's own **Task Manager** (Shift+Esc) shows per-process memory but not a
tree total. To sum the whole tree on Windows, PowerShell:

```powershell
# Total working set (MB) of every Chrome process:
"{0:N0} MB" -f ((Get-Process chrome -ErrorAction SilentlyContinue |
  Measure-Object WorkingSet64 -Sum).Sum / 1MB)

# Edge: swap 'chrome' for 'msedge'. Flux (cross-check the in-app number):
"{0:N0} MB" -f ((Get-Process flux -ErrorAction SilentlyContinue |
  Measure-Object WorkingSet64 -Sum).Sum / 1MB)
```

On Linux (WebKitGTK build), sum RSS by tree:

```sh
# RSS (MB) of a process and its descendants, by name:
ps -o rss= --ppid "$(pgrep -d, -f flux)" -p "$(pgrep -d, -f flux)" \
  | awk '{s+=$1} END {printf "%d MB\n", s/1024}'
```

Use the **same machine, same session, same tab set** for every browser in a run
— absolute numbers vary by OS/hardware, the *ratio* is the story.

## Results

Record each run here (date, build, machine). Fill in real numbers from your
Windows build — the dev environment is WSL2/WebKitGTK and not representative.

| Date | Build | Machine | Browser | Idle | 10 tabs | 30 tabs |
|---|---|---|---|---|---|---|
| _TODO_ | flux `<sha>` | _e.g. Win11 / 32 GB_ | **Flux** | | | |
| | | | Chrome | | | |
| | | | Edge | | | |

ADR 0001 targets for reference: **idle shell+daemon < 150 MB** (excl. webviews &
model). Chrome's idle is typically 300–500 MB across its mandatory process set;
the per-tab delta is where the gap widens.

## Artifact budgets (gated in CI)

These run with no display and **block merge** when exceeded:

```sh
npm run perf          # builds the shell, checks chrome JS gzip + binary size
cargo bench -p flux-core --bench ipc   # ipc_roundtrip, dom_snapshot latency
```

| Budget | Limit | Where |
|---|---|---|
| Chrome JS (gzip, eager) | ≤ 50 KB | `scripts/perf-budget.mjs` → CI `chrome-budget` |
| Release binary | ≤ 25 MB | `scripts/perf-budget.mjs --binary` → CI `binary-size` |
| `ipc_roundtrip` (1 KB) | < 1 ms p99 | `benches/ipc.rs` → CI `benches` |
| `dom_snapshot` (5 MB) | < 12 ms p99 | `benches/ipc.rs` → CI `benches` |
