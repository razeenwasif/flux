/**
 * Settings › Phone link (phonelink.rs, ADR 0022): lets Flux on your iPhone
 * read this Mac's calendar and inbox, and ask Fairy, for its notch island,
 * over Tailscale.
 */
import { invoke } from "@tauri-apps/api/core";
import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js";

import { Row, Toggle } from "./SettingsControls";

type PhoneDevice = { id: string; name: string; paired_ms: number; last_seen_ms: number };
type PhoneLinkState = {
  enabled: boolean;
  listening: boolean;
  tailscale: boolean;
  name: string;
  problem: string;
  devices: PhoneDevice[];
};

const ago = (ms: number) => {
  if (!ms) return "never";
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 2) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(ms).toLocaleDateString();
};

const PhoneLinkSettings: Component = () => {
  const [s, setS] = createSignal<PhoneLinkState | null>(null);
  const [copied, setCopied] = createSignal(false);
  const [err, setErr] = createSignal("");
  const load = () =>
    void invoke<PhoneLinkState>("phonelink_state")
      .then(setS)
      .catch(() => {});
  onMount(() => {
    load();
    // Tailscale comes and goes; the Mac checks every 20 s.
    const iv = setInterval(load, 5000);
    onCleanup(() => clearInterval(iv));
  });

  const toggle = async () => {
    setErr("");
    try {
      setS(await invoke<PhoneLinkState>("phonelink_set_enabled", { on: !s()?.enabled }));
    } catch (e) {
      setErr(String(e));
    }
  };
  const copyPair = async () => {
    setErr("");
    try {
      const link = await invoke<string>("phonelink_pair");
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 5 * 60_000);
    } catch (e) {
      setErr(String(e));
    }
  };
  const forget = async (id: string) => setS(await invoke<PhoneLinkState>("phonelink_forget", { id }));

  const status = () => {
    const v = s();
    if (!v?.enabled) return "Off.";
    if (v.problem) return v.problem;
    if (!v.tailscale) return "Waiting for Tailscale. Turn it on, with MagicDNS, and Flux starts listening.";
    if (!v.listening) return "Starting…";
    return `Listening on ${v.name}, for your Tailscale devices only.`;
  };

  return (
    <>
      <Row
        label="Phone link"
        hint="Flux on your iPhone shows this Mac's Google Calendar and Gmail in its notch island, and can ask Fairy about the page it's on. It reads only: events, and the sender, subject and time of your newest mail (nothing is marked read). It works over Tailscale and nothing else."
      >
        <Toggle on={!!s()?.enabled} onClick={() => void toggle()} />
      </Row>
      <Show when={s()?.enabled}>
        <div class="set-status-line">{status()}</div>
        <Row
          label="Pair a phone"
          hint="Copies a one-time link. It reaches your iPhone through Universal Clipboard: open the island in Flux there, go to Calendar, and tap Paste pairing link. The link works once, for five minutes."
        >
          <button class="set-link-btn" disabled={!s()?.listening} onClick={() => void copyPair()}>
            {copied() ? "Copied" : "Copy pairing link"}
          </button>
        </Row>
        <Show when={s()!.devices.length > 0}>
          <Row label="Paired phones" hint="Forget one and it can't read anything until it pairs again.">
            <div class="set-stack-control">
              <For each={s()!.devices}>
                {(d) => (
                  <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
                    <span class="set-row-hint">
                      {d.name} · seen {ago(d.last_seen_ms)}
                    </span>
                    <button class="set-link-btn" onClick={() => void forget(d.id)}>
                      Forget
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Row>
        </Show>
      </Show>
      <Show when={err()}>
        <div class="set-status-line">{err()}</div>
      </Show>
    </>
  );
};

export default PhoneLinkSettings;
