# audioviz — Flux music-bubble visualiser helper (#126)

A tiny WSL helper that taps the system's playback (the default sink's PulseAudio
**monitor** source — whatever AudioPulse/librespot is actually playing), computes a
smoothed energy + bass/mid/treble envelope, and streams it as Server-Sent Events
on `http://0.0.0.0:3232/levels` (~40 fps). Flux's orb pulses to it.

No external Go deps — it shells out to `parec` (from `pulseaudio-utils`) and uses
only the stdlib.

## Build (once, in WSL)

```sh
go build -o ~/.local/bin/audioviz ./tools/audioviz   # from the flux repo
```

Then it's on your PATH as `audioviz`, and Flux starts it automatically the first
time music plays (via the bubble). You can also run it by hand to check it:

```sh
audioviz                 # serves SSE
curl -N localhost:3232/levels   # watch frames while music plays
```

## Requirements
- `parec` + `pactl` (`sudo apt install pulseaudio-utils`).
- Audio playing through PulseAudio/PipeWire-pulse (WSLg provides this).

## Env
- `AUDIOVIZ_ADDR`   — listen address (default `0.0.0.0:3232`).
- `AUDIOVIZ_DEVICE` — capture device (default: the default sink's `.monitor`).

Flux's side: `audioviz_stream` proxies the SSE (override the URL with
`FLUX_AUDIOVIZ_URL`; override the launch command with `FLUX_AUDIOVIZ_START`).
