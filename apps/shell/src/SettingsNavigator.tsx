import {
  For,
  Show,
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  type Component,
  type JSX,
} from "solid-js";

export const Section: Component<{ title: string; sub?: string; children: JSX.Element }> = (props) => {
  const id = createUniqueId();
  return (
    <section class="set-section" aria-labelledby={id} data-section={props.title}>
      <div class="set-section-head">
        <h2 id={id}>{props.title}</h2>
        <Show when={props.sub}>
          <span class="set-section-sub">{props.sub}</span>
        </Show>
      </div>
      <div class="set-card">{props.children}</div>
    </section>
  );
};

/** Hide, rather than remount, sections so searching preserves unsaved form values. */
const SettingsNavigator: Component<{ children: JSX.Element }> = (props) => {
  let body!: HTMLDivElement;
  let input!: HTMLInputElement;
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal("All settings");
  const [sections, setSections] = createSignal<HTMLElement[]>([]);
  const [matches, setMatches] = createSignal(0);
  const normalize = (s: string) =>
    s
      .toLocaleLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "");

  const filter = () => {
    const terms = normalize(query().trim()).split(/\s+/).filter(Boolean);
    const matchesText = (s: string) => terms.every((term) => normalize(s).includes(term));
    let count = 0;
    for (const section of sections()) {
      const title = section.dataset.section ?? "";
      const inCategory = terms.length > 0 || selected() === "All settings" || selected() === title;
      let visibleRows = 0;
      for (const row of section.querySelectorAll<HTMLElement>(".set-row")) {
        // Index labels and explanations, never a password, API key or typed value.
        const text = Array.from(row.querySelectorAll(".set-row-label, .set-row-hint"))
          .map((el) => el.textContent ?? "")
          .join(" ");
        row.hidden = !inCategory || !matchesText(`${title} ${text}`);
        if (!row.hidden) visibleRows++;
      }
      section.hidden = !inCategory || (terms.length > 0 && visibleRows === 0);
      if (!section.hidden) count += visibleRows;
    }
    setMatches(count);
  };
  createEffect(filter);
  onMount(() => {
    setSections(Array.from(body.querySelectorAll<HTMLElement>(".set-section")));
    // Conditional provider controls can appear while the page is filtered.
    const observer = new MutationObserver(filter);
    observer.observe(body, { childList: true, subtree: true });
    onCleanup(() => observer.disconnect());
  });
  const select = (title: string) => {
    setQuery("");
    setSelected(title);
    body.scrollTop = 0;
  };
  return (
    <>
      <div class="set-search-bar">
        <input
          ref={input}
          type="search"
          aria-label="Search settings"
          placeholder="Search settings…"
          value={query()}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            body.scrollTop = 0;
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query()) {
              e.stopPropagation();
              setQuery("");
            }
          }}
        />
        <Show when={query()}>
          <button
            class="set-link-btn"
            onClick={() => {
              setQuery("");
              input.focus();
            }}
          >
            Clear
          </button>
        </Show>
      </div>
      <div class="set-layout">
        <nav class="set-nav" aria-label="Settings categories">
          <For each={["All settings", ...sections().map((s) => s.dataset.section!)]}>
            {(title) => (
              <button
                aria-current={!query() && selected() === title ? "page" : undefined}
                onClick={() => select(title)}
              >
                {title}
              </button>
            )}
          </For>
        </nav>
        <div class="set-results">
          <Show when={query()}>
            <div class="set-search-status" role="status">
              {matches() ? `${matches()} matching settings` : "No settings found. Try another search."}
            </div>
          </Show>
          <div ref={body} class="set-body">
            {props.children}
          </div>
        </div>
      </div>
    </>
  );
};
export default SettingsNavigator;
