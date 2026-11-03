// Settings → Indexer: which folder of PDFs the Indexer reads as your books
// (indexer.rs). Folders beyond this one are added in the Indexer's own panel.
// A typed path, as there: Flux has no folder picker.
import { Component, Show, createSignal, onCleanup, onMount } from "solid-js";
import { indexerBooksFolder, indexerSetBooksFolder, indexerStatus, type IndexerBooksFolder } from "./indexer";
import { Row } from "./SettingsControls";

const IndexerSettings: Component = () => {
  const [folder, setFolder] = createSignal<IndexerBooksFolder | null>(null);
  const [typed, setTyped] = createSignal("");
  const [error, setError] = createSignal("");
  const [progress, setProgress] = createSignal("");
  let poll: number | undefined;
  let gone = false;
  onCleanup(() => {
    gone = true;
    clearTimeout(poll);
  });

  const adopt = (f: IndexerBooksFolder) => {
    setFolder(f);
    setTyped(f.path);
  };
  onMount(
    () =>
      void indexerBooksFolder()
        .then(adopt)
        .catch((e) => setError(String(e))),
  );

  /** After a change only: asking for the count loads the index, which just
   *  opening Settings shouldn't. */
  const watchReading = async () => {
    clearTimeout(poll);
    try {
      const s = await indexerStatus();
      if (gone) return;
      const here = s.shelves.find((x) => x.path === folder()?.path);
      if (s.building) {
        setProgress(
          s.files_todo
            ? `Reading ${s.files_done.toLocaleString()} of ${s.files_todo.toLocaleString()} files…`
            : "Checking the folder…",
        );
        poll = window.setTimeout(() => void watchReading(), 1000);
      } else if (here) {
        setProgress(`${here.books.toLocaleString()} book${here.books === 1 ? "" : "s"} in this folder.`);
      } else setProgress("");
    } catch {
      setProgress("");
    }
  };

  const choose = async (path: string | null) => {
    setError("");
    try {
      adopt(await indexerSetBooksFolder(path));
      void watchReading();
    } catch (e) {
      setError(String(e));
    }
  };

  const commit = () => {
    const f = folder();
    const path = typed().trim();
    if (!f || !path || path === f.path) {
      if (f && !path) setTyped(f.path);
      return;
    }
    void choose(path);
  };

  const hint = (): string => {
    const f = folder();
    if (error()) return error();
    if (f?.from_env) return "Set by FLUX_INDEXER_BOOKS, which outranks this setting.";
    if (f?.missing) return "This folder isn't there right now, so no books are read from it.";
    if (progress()) return progress();
    return "The Indexer reads every PDF in this folder as your books. Add other folders in its panel.";
  };

  return (
    <Show when={folder()}>
      {(f) => (
        <Row label="Books folder" hint={hint()}>
          <div class="set-stack-control">
            <input
              class="map-search-input"
              style={{ "max-width": "340px" }}
              aria-label="Books folder"
              placeholder={f().default_path}
              spellcheck={false}
              disabled={f().from_env}
              value={typed()}
              onInput={(e) => setTyped(e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              onChange={commit}
            />
            <Show when={f().chosen && !f().from_env}>
              <button class="set-link-btn" onClick={() => void choose(null)}>
                Use the default
              </button>
            </Show>
          </div>
        </Row>
      )}
    </Show>
  );
};

export default IndexerSettings;
