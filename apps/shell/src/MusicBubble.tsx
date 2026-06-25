/**
 * Music bubble (#125) — a floating Siri-style orb pinned to Flux's right edge that
 * expands on hover into a rounded mini-player for AudioPulse/Spotify. Controls
 * (play/pause, skip, volume, shuffle, repeat) + a playlist menu drive the same
 * Spotify Connect playback AudioPulse uses, via Flux's existing spotify backend.
 * The orb breathes while playing (a real beat-synced visualiser is #126, next).
 * Palette: purple / pink / indigo.
 */
import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js";

import {
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

const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const MusicBubble: Component = () => {
  const [st, setSt] = createSignal<SpotifyState | null>(null);
  const [reachable, setReachable] = createSignal(true);
  const [expanded, setExpanded] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [playlists, setPlaylists] = createSignal<SpotifyPlaylist[]>([]);

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
  // Self-rescheduling poll: snappy while open, calm when collapsed, backed off
  // when Spotify isn't reachable (so an un-set-up user pays almost nothing).
  let timer: number | undefined;
  const schedule = () => {
    const delay = !reachable() ? 9000 : expanded() ? 1000 : 3500;
    timer = window.setTimeout(async () => { await poll(); schedule(); }, delay);
  };
  const loadPlaylists = () => void spotifyPlaylists().then(setPlaylists).catch(() => {});

  onMount(() => {
    void poll().then(schedule);
    loadPlaylists();
  });
  onCleanup(() => clearTimeout(timer));

  // Hover with a small leave-delay so brushing past doesn't flap it.
  let leaveT: number | undefined;
  const enter = () => { clearTimeout(leaveT); if (!expanded()) { setExpanded(true); void poll(); } };
  const leave = () => { clearTimeout(leaveT); leaveT = window.setTimeout(() => { setExpanded(false); setMenuOpen(false); }, 260); };

  const playing = () => st()?.playing ?? false;
  const after = (ms = 350) => window.setTimeout(() => void poll(), ms);
  const togglePlay = () => { void (playing() ? spotifyPause() : spotifyResume()).catch(() => {}); after(); };
  const next = () => { void spotifyNext().catch(() => {}); after(450); };
  const prev = () => { void spotifyPrev().catch(() => {}); after(450); };
  const toggleShuffle = () => { void spotifyShuffle(!(st()?.shuffle ?? false)).catch(() => {}); after(); };
  const cycleRepeat = () => {
    const cur = st()?.repeat ?? "off";
    const nextMode = cur === "off" ? "context" : cur === "context" ? "track" : "off";
    void spotifyRepeat(nextMode).catch(() => {});
    after();
  };
  const setVol = (v: number) => {
    setSt((s) => (s ? { ...s, volume: v } : s)); // optimistic
    void spotifyVolume(v).catch(() => {});
  };
  const play = (p: SpotifyPlaylist) => { setMenuOpen(false); void spotifyPlayContext(p.uri).catch(() => {}); after(700); };

  const pct = () => {
    const s = st();
    return s && s.duration_ms > 0 ? Math.min(100, (s.progress_ms / s.duration_ms) * 100) : 0;
  };
  const artBg = () => (st()?.art ? `url("${st()!.art}")` : undefined);

  return (
    <div
      classList={{ music: true, expanded: expanded(), playing: playing(), dormant: !reachable() }}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      {/* Orb / visualiser (also the collapsed bubble). */}
      <div class="music-orb" style={{ "background-image": artBg() }}>
        <div class="music-orb-glow" />
        <Show when={!expanded() && playing()}>
          <span class="music-orb-eq"><i /><i /><i /></span>
        </Show>
      </div>

      {/* Expanded player body. */}
      <div class="music-body">
        <div class="music-track">
          <Show when={st()?.track} fallback={<span class="music-dim">{reachable() ? "Nothing playing" : "Spotify not connected"}</span>}>
            <span class="music-title" title={st()!.track}>{st()!.track}</span>
            <span class="music-artist" title={st()!.artist}>{st()!.artist}</span>
          </Show>
        </div>

        <div class="music-prog">
          <div class="music-prog-bar"><div class="music-prog-fill" style={{ width: `${pct()}%` }} /></div>
          <div class="music-prog-times"><span>{fmt(st()?.progress_ms ?? 0)}</span><span>{fmt(st()?.duration_ms ?? 0)}</span></div>
        </div>

        <div class="music-controls">
          <button classList={{ "music-btn": true, on: st()?.shuffle }} title="Shuffle" onClick={toggleShuffle}>🔀</button>
          <button class="music-btn" title="Previous" onClick={prev}>⏮</button>
          <button class="music-btn music-play" title={playing() ? "Pause" : "Play"} onClick={togglePlay}>{playing() ? "⏸" : "▶"}</button>
          <button class="music-btn" title="Next" onClick={next}>⏭</button>
          <button classList={{ "music-btn": true, on: (st()?.repeat ?? "off") !== "off" }} title={`Repeat: ${st()?.repeat ?? "off"}`} onClick={cycleRepeat}>
            {st()?.repeat === "track" ? "🔂" : "🔁"}
          </button>
        </div>

        <div class="music-vol">
          <span>🔊</span>
          <input type="range" min="0" max="100" value={st()?.volume ?? 50} onInput={(e) => setVol(Number(e.currentTarget.value))} />
        </div>

        <button class="music-menu-btn" onClick={() => { setMenuOpen((v) => !v); if (!playlists().length) loadPlaylists(); }}>≡ Playlists</button>
        <Show when={menuOpen()}>
          <div class="music-menu">
            <For each={playlists()} fallback={<div class="music-dim" style={{ padding: "8px 10px" }}>No playlists found.</div>}>
              {(p) => (
                <button class="music-menu-item" title={p.name} onClick={() => play(p)}>
                  <span class="music-menu-art" style={{ "background-image": p.art ? `url("${p.art}")` : undefined }} />
                  <span class="music-menu-name">{p.name}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default MusicBubble;
