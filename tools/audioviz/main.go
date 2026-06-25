// audioviz — a tiny WSL helper for Flux's music-bubble visualiser (#126).
//
// It taps the system's playback (the default sink's PulseAudio *monitor* source,
// i.e. whatever AudioPulse/librespot is actually playing), computes a smoothed
// energy + bass/mid/treble envelope, and streams it as Server-Sent Events on
// http://0.0.0.0:3232/levels (~40 fps). Flux's Rust side relays that to the orb
// so the bubble pulses to the real beat — no Spotify API, works for any audio.
//
// No external deps: it shells out to `parec` (pulseaudio-utils) for raw PCM and
// uses only the Go stdlib. Build:  go build -o ~/.local/bin/audioviz ./tools/audioviz
//
// Env: AUDIOVIZ_ADDR (default 0.0.0.0:3232), AUDIOVIZ_DEVICE (default: the default
// sink's monitor, auto-detected via `pactl get-default-sink`).
package main

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

type frame struct {
	E, Bass, Mid, Treble float64
}

var (
	mu  sync.RWMutex
	cur frame
)

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func main() {
	addr := env("AUDIOVIZ_ADDR", "0.0.0.0:3232")
	go captureLoop()
	http.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	http.HandleFunc("/levels", sse)
	log.Printf("audioviz: serving SSE on %s/levels", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}

// defaultMonitor resolves the monitor source of the default sink.
func defaultMonitor() string {
	out, err := exec.Command("pactl", "get-default-sink").Output()
	if err != nil {
		return "@DEFAULT_MONITOR@" // best-effort fallback
	}
	sink := strings.TrimSpace(string(out))
	if sink == "" {
		return "@DEFAULT_MONITOR@"
	}
	return sink + ".monitor"
}

// captureLoop runs parec on the monitor and keeps reading; it reconnects if parec
// dies (e.g. the sink changed), so the helper survives device churn.
func captureLoop() {
	for {
		if err := capture(); err != nil {
			log.Printf("audioviz: capture ended (%v) — retrying in 2s", err)
		}
		// On failure, decay to silence so the orb settles instead of freezing.
		mu.Lock()
		cur = frame{}
		mu.Unlock()
		time.Sleep(2 * time.Second)
	}
}

func capture() error {
	device := env("AUDIOVIZ_DEVICE", defaultMonitor())
	const rate = 22050
	cmd := exec.Command("parec", "--format=s16le", fmt.Sprintf("--rate=%d", rate), "--channels=1", "--raw", "-d", device)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start parec (is pulseaudio-utils installed?): %w", err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()

	r := bufio.NewReaderSize(stdout, 1<<16)
	const win = 512 // ~23 ms at 22050 Hz → ~43 frames/s
	buf := make([]byte, win*2)

	// One-pole filter states for a cheap 3-band split, and envelope followers with
	// fast attack / slow release so beats punch and then fade (no jitter).
	var lpBass, lpMid float64
	var eEnv, bEnv, mEnv, tEnv float64
	var peak = 0.15 // auto-gain reference, tracked slowly

	follow := func(env, x float64) float64 {
		if x > env {
			return env + 0.6*(x-env) // attack
		}
		return env + 0.12*(x-env) // release
	}

	for {
		if _, err := io.ReadFull(r, buf); err != nil {
			return err
		}
		var sumSq, bSq, mSq, tSq float64
		for i := 0; i < win; i++ {
			s := float64(int16(binary.LittleEndian.Uint16(buf[i*2:]))) / 32768.0
			sumSq += s * s
			lpBass += 0.04 * (s - lpBass)   // ~low band
			bSq += lpBass * lpBass
			lpMid += 0.30 * (s - lpMid)      // ~low-mid
			mid := lpMid - lpBass            // mid = low-mid minus bass
			mSq += mid * mid
			hp := s - lpMid                  // treble = above low-mid
			tSq += hp * hp
		}
		n := float64(win)
		e := math.Sqrt(sumSq / n)
		// Track a slow peak for auto-gain so quiet and loud tracks both fill the orb.
		if e > peak {
			peak += 0.25 * (e - peak)
		} else {
			peak += 0.0008 * (e - peak)
		}
		if peak < 0.02 {
			peak = 0.02
		}
		g := func(x float64) float64 {
			v := x / (peak * 1.4)
			if v > 1 {
				v = 1
			}
			return v
		}
		eEnv = follow(eEnv, g(e))
		bEnv = follow(bEnv, g(math.Sqrt(bSq/n)))
		mEnv = follow(mEnv, g(math.Sqrt(mSq/n)*1.6))
		tEnv = follow(tEnv, g(math.Sqrt(tSq/n)*2.2))

		mu.Lock()
		cur = frame{E: eEnv, Bass: bEnv, Mid: mEnv, Treble: tEnv}
		mu.Unlock()
	}
}

func sse(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "no flush", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	tick := time.NewTicker(25 * time.Millisecond) // ~40 fps
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-tick.C:
			mu.RLock()
			f := cur
			mu.RUnlock()
			fmt.Fprintf(w, "data: {\"e\":%.3f,\"bass\":%.3f,\"mid\":%.3f,\"treble\":%.3f}\n\n", f.E, f.Bass, f.Mid, f.Treble)
			fl.Flush()
		}
	}
}
