/**
 * flux://omni — a native, velvet/glass view of the Omni search index's health.
 *
 * Mirrors Omni's own `/dashboard` (live-stat cards, per-segment bars, an
 * essential-sites grid, and the PageRank authority list) but rendered in Flux's
 * style and refreshed from `/stats` via the `omni_stats` Rust command (the shell
 * CSP blocks a direct fetch to `http://localhost:8080`). Clicking a site or a
 * ranked doc navigates this tab there.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { omniStats, type OmniStats } from "./ipc";

const REFRESH_MS = 2500;

/** Curated essential sites — mirrors Omni's bang table (`!key` to jump in search). */
const SITES = [
  { key: "yt", name: "YouTube", home: "https://www.youtube.com", blurb: "video lectures, talks, and tutorials" },
  { key: "gh", name: "GitHub", home: "https://github.com", blurb: "source code, repositories, and projects" },
  { key: "ol", name: "Overleaf", home: "https://www.overleaf.com", blurb: "collaborative LaTeX papers and templates" },
  { key: "so", name: "Stack Overflow", home: "https://stackoverflow.com", blurb: "programming questions and answers" },
  { key: "w", name: "Wikipedia", home: "https://en.wikipedia.org", blurb: "the free encyclopedia" },
  { key: "ax", name: "arXiv", home: "https://arxiv.org", blurb: "open-access e-prints in physics, math, CS" },
  { key: "sc", name: "Google Scholar", home: "https://scholar.google.com", blurb: "scholarly papers and citations" },
  { key: "wa", name: "Wolfram Alpha", home: "https://www.wolframalpha.com", blurb: "computational answers and math" },
  { key: "mdn", name: "MDN Web Docs", home: "https://developer.mozilla.org", blurb: "web platform and JavaScript reference" },
];

const OmniDashboard: Component<{ onNavigate: (url: string) => void }> = (props) => {
  const [stats, setStats] = createSignal<OmniStats | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let timer: number | undefined;

  const tick = async () => {
    try {
      setStats(await omniStats());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  onMount(() => {
    void tick();
    timer = window.setInterval(() => void tick(), REFRESH_MS);
    onCleanup(() => clearInterval(timer));
  });

  const cards = createMemo(() => {
    const s = stats();
    if (!s) return [];
    return [
      { label: "Live documents", num: s.live_docs.toLocaleString(), sub: `${s.total_docs.toLocaleString()} on disk` },
      { label: "Segments", num: String(s.segments), sub: "merge-balanced", accent: true },
      { label: "Tombstones", num: s.tombstones.toLocaleString(), sub: "reclaim on merge" },
      { label: "Embeddings", num: s.embedded ? `on · ${s.embedder_kind} ${s.embedder_dim}d` : "off", sub: "semantic / hybrid", sm: true },
      { label: "ANN (HNSW)", num: s.ann ? `${s.ann_vectors.toLocaleString()} vec` : "—", sub: s.ann ? "sub-linear recall" : "brute-force", sm: true },
      { label: "Avg length", num: `${Math.round(s.avg_body_len)}`, sub: `body · ${Math.round(s.avg_title_len)} title`, sm: true },
    ];
  });

  const segMax = () => Math.max(1, ...(stats()?.segment_sizes ?? []).map((x) => x.total));
  const topDocs = createMemo(() => (stats()?.top_docs ?? []).filter((d) => d.rank > 0));

  return (
    <div class="omni">
      <header class="omni-head">
        <span class="omni-brand"><span class="omni-spark">✦</span> Omni <span class="omni-sub">index dashboard</span></span>
        <span style={{ flex: 1 }} />
        <Show
          when={!error()}
          fallback={<span class="omni-status off">offline</span>}
        >
          <span class="omni-status live"><span class="omni-dot" /> live · {REFRESH_MS / 1000}s</span>
        </Show>
      </header>

      <Show
        when={stats()}
        fallback={
          <div class="omni-empty">
            {error() ? `Couldn't reach Omni — ${error()}` : "Connecting to Omni…"}
          </div>
        }
      >
        {(s) => (
          <>
            <div class="omni-cards">
              <For each={cards()}>
                {(c) => (
                  <div classList={{ "omni-card": true, accent: !!c.accent }}>
                    <div classList={{ "omni-card-num": true, sm: !!c.sm }}>{c.num}</div>
                    <div class="omni-card-label">{c.label}</div>
                    <div class="omni-card-sub">{c.sub}</div>
                  </div>
                )}
              </For>
            </div>

            <section class="omni-panel">
              <div class="omni-panel-h">
                Segments <span class="omni-note">{s().segment_sizes.length} · largest {segMax().toLocaleString()} docs</span>
              </div>
              <div class="omni-segbars">
                <For each={s().segment_sizes}>
                  {(x, i) => (
                    <div class="omni-segrow">
                      <span class="omni-segidx">#{i()}</span>
                      <span class="omni-segbar" style={{ width: `${Math.max(2, (x.total / segMax()) * 100)}%` }}>
                        <span class="omni-segfill" style={{ width: `${x.total ? (x.live / x.total) * 100 : 0}%` }} />
                      </span>
                      <span class="omni-segn">
                        {x.live.toLocaleString()}{x.live !== x.total ? ` / ${x.total.toLocaleString()}` : ""}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </section>

            <section class="omni-panel">
              <div class="omni-panel-h">Essential sites <span class="omni-note">type <code>!key</code> in search to jump</span></div>
              <div class="omni-sites">
                <For each={SITES}>
                  {(site) => (
                    <button class="omni-site" onClick={() => props.onNavigate(site.home)} title={site.home}>
                      <span class="omni-bang">!{site.key}</span>
                      <span class="omni-site-name">{site.name}</span>
                      <span class="omni-site-blurb">{site.blurb}</span>
                    </button>
                  )}
                </For>
              </div>
            </section>

            <section class="omni-panel">
              <div class="omni-panel-h">Top authority · PageRank</div>
              <Show when={topDocs().length > 0} fallback={<div class="omni-empty sm">No PageRank yet (no link graph).</div>}>
                <ol class="omni-toplist">
                  <For each={topDocs()}>
                    {(d) => (
                      <li class="omni-topitem" onClick={() => props.onNavigate(d.url)}>
                        <span class="omni-top-title">{d.title || d.url}</span>
                        <span class="omni-top-rank">{d.rank.toFixed(4)}</span>
                        <span class="omni-top-url">{d.url}</span>
                      </li>
                    )}
                  </For>
                </ol>
              </Show>
            </section>
          </>
        )}
      </Show>
    </div>
  );
};

export default OmniDashboard;
