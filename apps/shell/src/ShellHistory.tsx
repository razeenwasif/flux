/**
 * Semantic shell-history search (BACKLOG #122) — Ctrl+Shift+R (or the command
 * palette) opens this overlay; type what a command *did* ("convert a video to
 * webm", "that long ffmpeg one") and it ranks your real shell history by meaning,
 * not substring. Pick one to drop it at the active terminal's prompt (you press
 * Enter), or it's copied to the clipboard if no terminal is open.
 */
import { For, Show, createEffect, createSignal, onCleanup, type Component } from "solid-js";
import { Portal } from "solid-js/web";

import { shellHistOpen, setShellHistOpen } from "./store";
import { shellHistorySearch, shellHistoryReindex, type ShellHistHit } from "./ipc";
import { insertInActiveTerminal } from "./terminals";

const relTime = (ts: number | null): string => {
  if (!ts) return "";
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 0) return "";
  const m = Math.floor(secs / 60),
    h = Math.floor(m / 60),
    d = Math.floor(h / 24);
  if (d > 60) return `${Math.floor(d / 30)}mo ago`;
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return "just now";
};

const ShellHistory: Component = () => {
  const [query, setQuery] = createSignal("");
  const [hits, setHits] = createSignal<ShellHistHit[]>([]);
  const [sel, setSel] = createSignal(0);
  const [indexing, setIndexing] = createSignal(false);
  let inputEl: HTMLInputElement | undefined;
  let timer: number | undefined;
  // Bumped by every search and every reopen, so only the newest reply lands:
  // replies can arrive out of order, and a stale one replaced what matches the box.
  let searchGen = 0;

  const runSearch = (q: string) => {
    const gen = ++searchGen;
    void shellHistorySearch(q, 40)
      .then((h) => {
        if (gen !== searchGen) return;
        setHits(h);
        setSel(0);
      })
      .catch(() => {
        if (gen === searchGen) setHits([]);
      });
  };

  // On open: reset, focus, reindex the corpus, then show what matches the box.
  createEffect(() => {
    if (!shellHistOpen()) return;
    searchGen++;
    clearTimeout(timer);
    setQuery("");
    setHits([]);
    setSel(0);
    setIndexing(true);
    void shellHistoryReindex()
      .catch(() => 0)
      .finally(() => {
        setIndexing(false);
        // What's in the box now, not "": the input is live while the corpus
        // rebuilds, and an empty search swapped the user's results (and the row
        // Enter picks) for recent commands.
        runSearch(query());
      });
    requestAnimationFrame(() => inputEl?.focus());
  });

  const onInput = (v: string) => {
    setQuery(v);
    clearTimeout(timer);
    timer = window.setTimeout(() => runSearch(v), 110);
  };

  const close = () => setShellHistOpen(false);
  const choose = (h: ShellHistHit) => {
    close();
    void insertInActiveTerminal(h.command).then((s) => {
      if (s == null) void navigator.clipboard?.writeText(h.command).catch(() => {});
    });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, hits().length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const h = hits()[sel()];
      if (h) choose(h);
    }
  };

  onCleanup(() => clearTimeout(timer));

  return (
    <Show when={shellHistOpen()}>
      <Portal>
        <div class="shellhist-backdrop" onClick={close}>
          <div class="shellhist glass" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
            <div class="shellhist-head">
              <span class="shellhist-ico">⌘</span>
              <input
                ref={inputEl}
                class="shellhist-input"
                placeholder="Search your shell history by meaning…"
                value={query()}
                onInput={(e) => onInput(e.currentTarget.value)}
                spellcheck={false}
                autocomplete="off"
              />
              <Show when={indexing()}>
                <span class="shellhist-indexing">indexing…</span>
              </Show>
            </div>
            <div class="shellhist-list">
              <For
                each={hits()}
                fallback={
                  <div class="shellhist-empty">
                    {indexing()
                      ? "Reading your history…"
                      : query()
                        ? "No matching commands."
                        : "No shell history found."}
                  </div>
                }
              >
                {(h, i) => (
                  <button
                    classList={{ "shellhist-item": true, sel: sel() === i() }}
                    onMouseEnter={() => setSel(i())}
                    onClick={() => choose(h)}
                  >
                    <span class="shellhist-cmd">{h.command}</span>
                    <span class="shellhist-meta">
                      {[relTime(h.ts), h.source].filter(Boolean).join(" · ")}
                    </span>
                  </button>
                )}
              </For>
            </div>
            <div class="shellhist-foot">↑↓ navigate · ↵ drop into terminal · esc close</div>
          </div>
        </div>
      </Portal>
    </Show>
  );
};

export default ShellHistory;
