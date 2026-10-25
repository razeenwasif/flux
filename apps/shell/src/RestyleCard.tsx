/**
 * A restyle drafted from a sentence (boosts.rs `boost_draft`): the CSS that
 * survived the checks, previewing on the page already. Apply saves it as a
 * Boost for the site; Discard takes the preview off. Its own chunk.
 */
import { Show, createSignal, type Component } from "solid-js";
import "./CitedAnswer.css";
import { boostSave, type BoostDraft } from "./ipc";
import { boostPreviewClear } from "./citeCardIpc";

const RestyleCard: Component<{ draft: BoostDraft }> = (props) => {
  const [state, setState] = createSignal<"open" | "applied" | "discarded">("open");
  const [error, setError] = createSignal("");
  const d = () => props.draft;
  const apply = async () => {
    try {
      await boostSave(null, d().host, d().name, d().css, true);
      setState("applied");
    } catch (e) {
      setError(String(e));
      return;
    }
    // The saved Boost is on the page now; the preview would only double it.
    void boostPreviewClear(d().tab).catch(() => {});
  };
  const discard = () => {
    setState("discarded");
    void boostPreviewClear(d().tab).catch(() => {});
  };
  return (
    <div class="ca-card ca-restyle">
      <span class="ca-legend">Restyle</span>
      <div class="ca-restyle-title">
        Restyle {d().host}: {d().name}
      </div>
      <pre class="ca-css">{d().css}</pre>
      <Show when={d().dropped > 0}>
        <div class="ca-note">
          {d().dropped} rule{d().dropped === 1 ? "" : "s"} matched nothing on this page and{" "}
          {d().dropped === 1 ? "was" : "were"} left out.
        </div>
      </Show>
      <Show
        when={state() === "open"}
        fallback={
          <div class="ca-note">
            {state() === "applied"
              ? `Saved as a Boost for ${d().host}.`
              : "Discarded; the page is back as it was."}
          </div>
        }
      >
        <div class="ca-actions">
          <button class="agent-approve-yes" onClick={() => void apply()}>
            Apply
          </button>
          <button class="agent-approve-no" onClick={discard}>
            Discard
          </button>
          <span class="ca-count">
            {d().previewed
              ? `Showing on the page · saves as a Boost for ${d().host}`
              : `Saves as a Boost for ${d().host}`}
          </span>
        </div>
      </Show>
      <Show when={error()}>
        <div class="ca-note">{error()}</div>
      </Show>
    </div>
  );
};

export default RestyleCard;
