/**
 * What a blocked site shows while you focus (focus.rs, focusStore.ts): the
 * site, the time left, Allow 5 minutes and End focus. It sits in the page's
 * card, where the page would be: the page itself is off screen (tiling.ts)
 * and, if it had loaded, suspended. Loaded on first use.
 */
import { Show, type Component } from "solid-js";

import { focusAllow, focusEnd } from "./focusIpc";
import { clockOf, focusLeft, forgetStopped, refreshFocus, type Cover } from "./focusStore";
import Icon from "./Icon";
import "./TimePage.css";

const FocusCover: Component<{ tab: number; cover: Cover; onNavigate: (url: string) => void }> = (props) => {
  // Where the tab goes once the site opens: a stopped navigation goes on; a
  // page that was already open wakes where it was.
  const open = () => {
    if (props.cover.stopped) {
      forgetStopped(props.tab);
      props.onNavigate(props.cover.url);
    }
  };
  const allow = async () => {
    await focusAllow(props.cover.site, 5).catch(() => {});
    await refreshFocus();
    open();
  };
  const end = async () => {
    await focusEnd().catch(() => {});
    await refreshFocus();
    open();
  };
  return (
    <div class="fc" role="region" aria-label={`${props.cover.site} is closed while you focus`}>
      <span class="fc-moon" aria-hidden="true">
        <Icon name="moon" size={26} />
      </span>
      <h1>
        <span class="fc-site">{props.cover.site}</span> is closed while you focus
      </h1>
      <p class="fc-left">
        <strong>{clockOf(focusLeft())}</strong> left
      </p>
      <div class="fc-actions">
        <button class="fc-btn" onClick={() => void allow()}>
          Allow 5 minutes
        </button>
        <button class="fc-btn" onClick={() => void end()}>
          End focus
        </button>
      </div>
      <Show when={props.cover.stopped}>
        <button class="fc-stay" onClick={() => forgetStopped(props.tab)}>
          Stay on this page
        </button>
      </Show>
    </div>
  );
};

export default FocusCover;
