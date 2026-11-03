/**
 * The floating answer card: ask your notes and read the answer without leaving
 * the page (the hotkey in Settings → Keyboard, or `flux --ask`). Native tab
 * webviews sit above all of the chrome's HTML, so this is a small webview of
 * its own over the page (hud.rs), made when you ask and gone when you dismiss
 * it. It costs nothing the rest of the time, and its bundle stays small because
 * this is all it loads.
 */
/* @refresh reload */
import { For, Show, createEffect, lazy, on, onCleanup, onMount, Suspense, type Component } from "solid-js";
import { render } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

import { createAsking, pct, readScope } from "./indexerAsking";
import { indexerReindex, indexerWarm, openNote, type IndexerMatch } from "./indexer";
import { pdfViewerUrl } from "./ipc";
import "./IndexerHud.css";

const AnswerText = lazy(() => import("./AnswerText"));

// The chrome's look (index.html does this before its first paint).
try {
  const theme = localStorage.getItem("flux.theme");
  if (theme && theme !== "velvet") document.documentElement.setAttribute("data-theme", theme);
} catch {
  /* the default palette, then */
}

const close = () => void invoke("hud_close").catch(() => {});

const IndexerHud: Component = () => {
  const a = createAsking(readScope);
  let input: HTMLInputElement | undefined;
  let card: HTMLElement | undefined;

  /** Pressing the hotkey again: stop and ask while listening, otherwise dismiss. */
  const again = (question: string | null) => {
    if (question) {
      a.cancelListening();
      a.setQuery(question);
      void a.ask(question);
    } else if (a.busy() === "listening") void a.listen();
    else close();
  };

  /** A book opens in Flux's PDF viewer at the passage's page, as a tab; a note
   *  in the text editor. The shell owns tabs, so the book goes through it. */
  const open = (m: IndexerMatch) => {
    if (m.book) {
      void emit("flux://open-url", [`${pdfViewerUrl(m.path)}&page=${m.page ?? 1}`, false]);
    } else void openNote(m.path).catch((e) => a.setNote(String(e)));
  };

  const copy = (text: string) => void navigator.clipboard.writeText(text).catch((e) => a.setNote(String(e)));

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (!a.cancelListening()) close();
      return;
    }
    if (document.activeElement === input) return;
    const n = a.order().length;
    if (n > 1 && e.key === "ArrowRight") a.setPage((p) => (p + 1) % n);
    if (n > 1 && e.key === "ArrowLeft") a.setPage((p) => (p - 1 + n) % n);
  };

  onMount(() => {
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
    onCleanup(a.dispose);

    // The webview is as tall as the card, up to what fits over the page.
    const report = () => {
      if (!card) return;
      const height = card.offsetHeight + 16;
      document.documentElement.classList.toggle("hud-scrolls", height > window.innerHeight + 1);
      void invoke("hud_resize", { height }).catch(() => {});
    };
    const ro = new ResizeObserver(report);
    if (card) ro.observe(card);
    onCleanup(() => ro.disconnect());

    const un = listen<string | null>("flux://hud-again", (e) => again(e.payload));
    onCleanup(() => void un.then((f) => f()));

    // A cold System 1 load takes ~20 s; start it while the question is asked.
    void indexerWarm().catch(() => {});
    // Picks up what was written since; only re-reads notes that changed.
    void indexerReindex().catch(() => {});

    input?.focus();
    void invoke<string | null>("hud_take_question")
      .then((q) => {
        if (q) {
          a.setQuery(q);
          void a.ask(q);
        } else void a.listen();
      })
      .catch((e) => a.setNote(String(e)));
  });

  // A new card starts at its top; and with an answer up, ←/→ page through the
  // matches rather than move a caret.
  createEffect(on(a.current, () => document.documentElement.scrollTo(0, 0)));
  createEffect(on(a.results, (r) => r && input?.blur()));

  const statusText = () => {
    switch (a.busy()) {
      case "listening":
        return "Listening… pause when you're done, or type";
      case "transcribing":
        return "Transcribing…";
      case "searching":
        return "Searching…";
      case "deciding":
        return "Not clear-cut — asking System 1…";
      default:
        return "";
    }
  };

  return (
    <section class="hud" ref={card} role="dialog" aria-label="Ask your notes">
      <form
        class="idx-ask"
        onSubmit={(e) => {
          e.preventDefault();
          a.cancelListening();
          void a.ask(a.query());
        }}
      >
        <input
          ref={input}
          class="idx-input"
          placeholder="Ask your notes…"
          value={a.query()}
          spellcheck={false}
          onInput={(e) => {
            // Typing is answering the question another way: the mic goes off.
            a.cancelListening();
            a.setQuery(e.currentTarget.value);
          }}
        />
        <button
          type="button"
          classList={{ "idx-mic": true, on: a.busy() === "listening" }}
          title={a.busy() === "listening" ? "Stop and ask" : "Ask out loud"}
          aria-label={a.busy() === "listening" ? "Stop listening" : "Ask out loud"}
          onClick={() => void a.listen()}
        >
          🎙
        </button>
        <button type="button" class="idx-close" title="Close (Esc)" aria-label="Close" onClick={close}>
          ✕
        </button>
      </form>

      <Show when={statusText()}>
        <div class="hud-status" role="status">
          <Show when={a.busy() === "listening"}>
            <span class="hud-level" style={{ "--lvl": a.level().toFixed(3) }} />
          </Show>
          {statusText()}
        </div>
      </Show>
      <Show when={a.note()}>
        <div class="hud-note">{a.note()}</div>
      </Show>

      <Show when={a.results()}>
        {(r) => (
          <Show
            when={a.current()}
            fallback={
              <div class="idx-empty">
                {r().matches.length ? "" : "Nothing in your notes or books matches that."}
              </div>
            }
          >
            {(m) => (
              <article class="idx-card">
                <Show when={a.verdict()}>
                  {(v) => <div classList={{ "idx-verdict": true, [v().kind]: true }}>{v().text}</div>}
                </Show>
                <header class="idx-head">
                  <h3 class="idx-q">{m().question}</h3>
                  <div class="idx-meta">
                    <span class="idx-badge" title="Hybrid match: meaning and keywords">
                      {pct(m().confidence)}
                    </span>
                    <span class="idx-source" title={m().path}>
                      {m().source}
                    </span>
                  </div>
                </header>
                <Show when={m().key_points.length && /interview/i.test(m().path)}>
                  <ul class="idx-points">
                    <For each={m().key_points}>{(k) => <li>{k}</li>}</For>
                  </ul>
                </Show>
                <Suspense fallback={<div class="idx-answer ans-book">{m().answer}</div>}>
                  <AnswerText class="idx-answer" text={m().answer} book={m().book} />
                </Suspense>
                <footer class="idx-foot">
                  <Show when={a.order().length > 1}>
                    <div class="idx-pager">
                      <button
                        title="Previous match (←)"
                        onClick={() => a.setPage((p) => (p - 1 + a.order().length) % a.order().length)}
                      >
                        ‹
                      </button>
                      <span>
                        {a.page() + 1} of {a.order().length}
                      </span>
                      <button
                        title="Next match (→)"
                        onClick={() => a.setPage((p) => (p + 1) % a.order().length)}
                      >
                        ›
                      </button>
                    </div>
                  </Show>
                  <button class="idx-act" onClick={() => copy(m().answer)}>
                    Copy
                  </button>
                  <button class="idx-act" onClick={() => open(m())}>
                    {m().book ? `Open p. ${m().page ?? 1}` : "Open note"}
                  </button>
                </footer>
              </article>
            )}
          </Show>
        )}
      </Show>
    </section>
  );
};

render(() => <IndexerHud />, document.getElementById("root")!);
