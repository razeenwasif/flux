/**
 * Music bubble (#125) — a floating Siri-style orb that expands on hover into a
 * TALL VERTICAL mini-player for AudioPulse/Spotify. **Drag the orb to park it
 * anywhere**; the position persists. It used to be pinned to the right edge,
 * vertically centred, where it sat on top of the connections rail and hid the
 * middle of the list — an overlay always covers something, so the answer is being
 * able to move it. Drives
 * the same Spotify Connect playback AudioPulse uses (Flux's spotify backend).
 * Every action surfaces its result/error as a toast (no more silent failures).
 * The orb breathes while playing (real beat-synced visualiser is #126).
 * Palette: purple / pink / indigo.
 */
import { For, Show, createEffect, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { Portal } from "solid-js/web";

import {
  audivizStream,
  spotifyLaunch,
  spotifyNext,
  spotifyPause,
  spotifyPlayContext,
  spotifyPlaylists,
  spotifyPrev,
  spotifyRepeat,
  spotifyResume,
  spotifyShuffle,
  spotifyState,
  spotifyVolume,
  type SpotifyPlaylist,
  type SpotifyState,
} from "./ipc";

type Pos = { x: number; y: number };

const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const MusicBubble: Component = () => {
  const [st, setSt] = createSignal<SpotifyState | null>(null);
  const [reachable, setReachable] = createSignal(true);
  const [hovering, setHovering] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [playlists, setPlaylists] = createSignal<SpotifyPlaylist[]>([]);
  const [toast, setToast] = createSignal<string | null>(null);
  const [vizLive, setVizLive] = createSignal(false);
  const expanded = () => hovering() || menuOpen();

  // ── where the bubble sits ──────────────────────────────────────────────────
  // Stored as the top-left corner in viewport pixels, defaulting to the bottom
  // right — over the tail of the connections rail rather than its middle.
  const POS_KEY = "flux.music.pos";
  const PAD = 12;
  const COLLAPSED = 56;
  const size = () => (expanded() ? { w: 86, h: 386 } : { w: COLLAPSED, h: COLLAPSED });
  const clampTo = (p: Pos, w: number, h: number): Pos => ({
    x: Math.max(PAD, Math.min(window.innerWidth - w - PAD, p.x)),
    y: Math.max(PAD, Math.min(window.innerHeight - h - PAD, p.y)),
  });
  const [pos, setPos] = createSignal<Pos>(
    (() => {
      try {
        const raw = localStorage.getItem(POS_KEY);
        if (raw) {
          const p = JSON.parse(raw) as Pos;
          if (Number.isFinite(p.x) && Number.isFinite(p.y)) return clampTo(p, COLLAPSED, COLLAPSED);
        }
      } catch {
        /* unreadable — fall through to the default corner */
      }
      return {
        x: window.innerWidth - COLLAPSED - PAD,
        y: window.innerHeight - COLLAPSED - PAD,
      };
    })(),
  );
  const [dragging, setDragging] = createSignal(false);
  /** Where it actually renders: the stored corner, pulled back on screen for the
   *  size it currently is. Expanding near an edge slides the card into view
   *  instead of moving where the bubble is parked. */
  const shown = () => {
    const { w, h } = size();
    return clampTo(pos(), w, h);
  };

  const startDrag = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const from = pos();
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    const move = (me: PointerEvent) => {
      // A few pixels of slop, so a click on the orb isn't read as a drag.
      if (!moved && Math.hypot(me.clientX - sx, me.clientY - sy) < 3) return;
      moved = true;
      setDragging(true);
      const { w, h } = size();
      setPos(clampTo({ x: from.x + (me.clientX - sx), y: from.y + (me.clientY - sy) }, w, h));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragging(false);
      if (!moved) return;
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(pos()));
      } catch {
        /* private mode / quota — it just won't survive a restart */
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // A window resize can strand the bubble outside the viewport; clamp it back to
  // the collapsed footprint so it's always grabbable again.
  onMount(() => {
    const onResize = () => setPos((p) => clampTo(p, COLLAPSED, COLLAPSED));
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
  });

  // Real beat-synced visualiser (#126): the audioviz helper streams audio levels;
  // we write them straight to CSS vars on the orb (bypassing Solid for the 40fps
  // hot path) so the orb scales/glows to the actual beat. Starts on first play.
  let rootEl: HTMLDivElement | undefined;
  let vizOn = false;
  let vizWatch: number | undefined;
  const onFrame = (f: { e: number; bass: number; mid: number; treble: number }) => {
    if (rootEl) {
      rootEl.style.setProperty("--viz-e", f.e.toFixed(3));
      rootEl.style.setProperty("--viz-bass", f.bass.toFixed(3));
      rootEl.style.setProperty("--viz-mid", f.mid.toFixed(3));
      rootEl.style.setProperty("--viz-treble", f.treble.toFixed(3));
    }
    if (!vizLive()) setVizLive(true);
    clearTimeout(vizWatch);
    vizWatch = window.setTimeout(() => setVizLive(false), 1200); // settle if frames stop
  };
  const startViz = () => {
    if (vizOn) return;
    vizOn = true;
    void audivizStream(onFrame)
      .catch(() => {})
      .finally(() => {
        vizOn = false;
        setVizLive(false);
        if (st()?.playing) window.setTimeout(startViz, 3000);
      });
  };

  let toastT: number | undefined;
  const flash = (msg: string) => {
    setToast(msg);
    clearTimeout(toastT);
    toastT = window.setTimeout(() => setToast(null), 3200);
  };

  let fails = 0;
  const poll = async () => {
    try {
      setSt(await spotifyState());
      setReachable(true);
      fails = 0;
    } catch {
      if (++fails >= 2) setReachable(false);
    }
  };
  let timer: number | undefined;
  const schedule = () => {
    const delay = !reachable() ? 9000 : expanded() ? 1000 : 3500;
    timer = window.setTimeout(async () => {
      await poll();
      schedule();
    }, delay);
  };
  const loadPlaylists = () =>
    void spotifyPlaylists()
      .then(setPlaylists)
      .catch((e) => flash(String(e)));

  onMount(() => {
    void poll().then(schedule);
    loadPlaylists();
  });
  // Kick the visualiser stream the first time something is playing (so the helper
  // only taps audio once there's music — not the whole time Flux is open).
  createEffect(() => {
    if (st()?.playing) startViz();
  });
  onCleanup(() => {
    clearTimeout(timer);
    clearTimeout(toastT);
    clearTimeout(leaveT);
    clearTimeout(vizWatch);
  });

  let leaveT: number | undefined;
  const enter = () => {
    clearTimeout(leaveT);
    if (!hovering()) {
      setHovering(true);
      void poll();
    }
  };
  const leave = () => {
    if (dragging()) return; // don't collapse out from under a drag
    clearTimeout(leaveT);
    leaveT = window.setTimeout(() => setHovering(false), 280);
  };

  // Run a command, surfacing its returned message OR error — the fix for silent
  // failures (e.g. "no active device — start AudioPulse").
  const run = (label: string, p: Promise<string>, repollMs = 400) => {
    void p.then((msg) => flash(msg && msg !== "▶" ? msg : label)).catch((e) => flash(String(e)));
    window.setTimeout(() => void poll(), repollMs);
  };

  const playing = () => st()?.playing ?? false;
  const togglePlay = () =>
    run(playing() ? "⏸ Paused" : "▶ Playing", playing() ? spotifyPause() : spotifyResume());
  const next = () => run("⏭ Next", spotifyNext(), 500);
  const prev = () => run("⏮ Previous", spotifyPrev(), 500);
  const toggleShuffle = () => run("🔀 Shuffle", spotifyShuffle(!(st()?.shuffle ?? false)));
  const cycleRepeat = () => {
    const cur = st()?.repeat ?? "off";
    const m = cur === "off" ? "context" : cur === "context" ? "track" : "off";
    run(`🔁 Repeat: ${m}`, spotifyRepeat(m));
  };
  const setVol = (v: number) => {
    setSt((s) => (s ? { ...s, volume: v } : s));
    void spotifyVolume(v).catch(() => {});
  };
  const play = (pl: SpotifyPlaylist) => {
    setMenuOpen(false);
    run(`▶ ${pl.name}`, spotifyPlayContext(pl.uri), 800);
  };
  const launch = () => run("Starting AudioPulse…", spotifyLaunch(), 4000);

  const pct = () => {
    const s = st();
    return s && s.duration_ms > 0 ? Math.min(100, (s.progress_ms / s.duration_ms) * 100) : 0;
  };
  const artBg = () => (st()?.art ? `url("${st()!.art}")` : undefined);

  return (
    <div
      class="music-wrap"
      classList={{ dragging: dragging() }}
      style={{ left: `${shown().x}px`, top: `${shown().y}px` }}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      <Show when={toast()}>
        <div class="music-toast">{toast()}</div>
      </Show>

      <div
        ref={rootEl}
        classList={{
          music: true,
          expanded: expanded(),
          playing: playing(),
          dormant: !reachable(),
          viz: vizLive(),
        }}
      >
        {/* The orb is the drag handle — it has no click action of its own, and
            it's the one part present in both the collapsed and expanded card. */}
        <div
          class="music-orb"
          title="Drag to move the player"
          style={{ "background-image": artBg() }}
          onPointerDown={startDrag}
        >
          <div class="music-orb-glow" />
          <Show when={!expanded() && playing()}>
            <span class="music-orb-eq">
              <i />
              <i />
              <i />
            </span>
          </Show>
        </div>

        <div class="music-body">
          <div class="music-track">
            <Show when={st()?.track} fallback={<span class="music-dim">{reachable() ? "—" : "off"}</span>}>
              <span class="music-title" title={`${st()!.track} — ${st()!.artist}`}>
                {st()!.track}
              </span>
              <span class="music-artist" title={st()!.artist}>
                {st()!.artist}
              </span>
            </Show>
          </div>

          <div class="music-prog">
            <div class="music-prog-fill" style={{ width: `${pct()}%` }} />
          </div>
          <div class="music-times">
            <span>{fmt(st()?.progress_ms ?? 0)}</span>
          </div>

          <button class="music-btn music-play" title={playing() ? "Pause" : "Play"} onClick={togglePlay}>
            {playing() ? "⏸" : "▶"}
          </button>
          <div class="music-row">
            <button class="music-btn" title="Previous" onClick={prev}>
              ⏮
            </button>
            <button class="music-btn" title="Next" onClick={next}>
              ⏭
            </button>
          </div>
          <div class="music-row">
            <button
              classList={{ "music-btn": true, on: st()?.shuffle }}
              title="Shuffle"
              onClick={toggleShuffle}
            >
              🔀
            </button>
            <button
              classList={{ "music-btn": true, on: (st()?.repeat ?? "off") !== "off" }}
              title={`Repeat: ${st()?.repeat ?? "off"}`}
              onClick={cycleRepeat}
            >
              {st()?.repeat === "track" ? "🔂" : "🔁"}
            </button>
          </div>

          <input
            class="music-vol"
            type="range"
            min="0"
            max="100"
            value={st()?.volume ?? 50}
            title="Volume"
            onInput={(e) => setVol(Number(e.currentTarget.value))}
          />

          <button
            class="music-btn music-menu-btn"
            title="Playlists"
            onClick={() => {
              setMenuOpen((v) => !v);
              if (!playlists().length) loadPlaylists();
            }}
          >
            ≡
          </button>

          <Show when={st() && !st()!.has_device}>
            <button class="music-launch" title="No active device — start AudioPulse" onClick={launch}>
              Start ▶
            </button>
          </Show>
        </div>
      </div>

      {/* Playlist menu — Portal'd so it isn't clipped by the orb; click-driven so it
          survives the mouse leaving the strip (menuOpen keeps the player expanded). */}
      <Show when={menuOpen()}>
        <Portal>
          <div class="music-menu-backdrop" onClick={() => setMenuOpen(false)} />
          <div class="music-menu">
            <div class="music-menu-title">Playlists</div>
            <For
              each={playlists()}
              fallback={
                <div class="music-dim" style={{ padding: "10px 12px" }}>
                  No playlists found.
                </div>
              }
            >
              {(p) => (
                <button class="music-menu-item" title={p.name} onClick={() => play(p)}>
                  <span
                    class="music-menu-art"
                    style={{ "background-image": p.art ? `url("${p.art}")` : undefined }}
                  />
                  <span class="music-menu-name">{p.name}</span>
                </button>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </div>
  );
};

export default MusicBubble;
