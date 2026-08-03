/**
 * `window.prompt`, but one that works.
 *
 * The native dialog is a **no-op in this webview** — it returns `null` without
 * showing anything. Every call site that used one was therefore dead code that
 * looked fine: renaming a Scribe notebook, naming a whiteboard, setting the
 * calendar's week 1, creating a task list. All silently did nothing, and the
 * equation editor joined them until it was caught.
 *
 * Deliberately promise-based with the same shape as `prompt()`, so replacing a
 * call is one `await` and no restructuring — the more a fix costs at each site,
 * the more sites keep the broken version.
 */
import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";

export type AskOptions = {
  title: string;
  /** Prefilled value — the current name, for a rename. */
  value?: string;
  placeholder?: string;
  /** Confirm button label. Defaults to "Save". */
  confirm?: string;
  /** Extra guidance under the field. */
  hint?: string;
};

/**
 * Ask for a line of text. Resolves with the trimmed value, or `null` if
 * cancelled — matching `prompt()`, so `?.trim()` call sites keep working.
 *
 * Rendered into its own detached root rather than through a global store: this
 * is called from components that have no business owning modal state, and a
 * dialog that outlives its caller is how you get two of them.
 */
export const askText = (opts: AskOptions): Promise<string | null> =>
  new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    let done = false;

    const finish = (value: string | null) => {
      if (done) return; // Esc during the closing frame would resolve twice
      done = true;
      dispose();
      host.remove();
      resolve(value);
    };

    const dispose = render(() => {
      const [text, setText] = createSignal(opts.value ?? "");
      let input: HTMLInputElement | undefined;
      // Select the existing value: a rename almost always replaces it, and
      // making the user clear the box first is the whole reason people avoid
      // renaming things.
      queueMicrotask(() => {
        input?.focus();
        input?.select();
      });

      const submit = (e: Event) => {
        e.preventDefault();
        const v = text().trim();
        finish(v ? v : null);
      };

      return (
        <>
          <div class="ask-scrim" onClick={() => finish(null)} />
          <form class="ask glass" onSubmit={submit}>
            <div class="ask-title">{opts.title}</div>
            <input
              ref={input}
              class="ask-input"
              value={text()}
              placeholder={opts.placeholder ?? ""}
              spellcheck={false}
              onInput={(e) => setText(e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation(); // chrome shortcuts must not fire while typing
                if (e.key === "Escape") finish(null);
              }}
            />
            {(opts.hint ? <div class="ask-hint">{opts.hint}</div> : null) as JSX.Element}
            <div class="ask-foot">
              <button type="button" class="ask-cancel" onClick={() => finish(null)}>
                Cancel
              </button>
              <button type="submit" class="ask-ok" disabled={!text().trim()}>
                {opts.confirm ?? "Save"}
              </button>
            </div>
          </form>
        </>
      );
    }, host);
  });
