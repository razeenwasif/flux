/**
 * flux://permissions — per-site permission manager (BACKLOG #38). Lists every
 * remembered camera/mic/location/notification decision grouped by site, lets the
 * user change Allow / Deny / Ask or revoke it, and add a rule manually. The
 * native engine prompts for the "Ask" case; a remembered Allow/Deny
 * short-circuits that prompt (enforced in permissions.rs on WebView2).
 */
import { For, Show, createMemo, createSignal, onMount, type Component } from "solid-js";
import {
  permissionsClearAll,
  permissionsClearHost,
  permissionsList,
  permissionsSet,
  type PermDecision,
  type PermKind,
  type SitePerm,
} from "./ipc";
import { activeId, updateTabTitle } from "./store";

const KINDS: { kind: PermKind; label: string; icon: string }[] = [
  { kind: "camera", label: "Camera", icon: "📷" },
  { kind: "microphone", label: "Microphone", icon: "🎙️" },
  { kind: "geolocation", label: "Location", icon: "📍" },
  { kind: "notifications", label: "Notifications", icon: "🔔" },
  { kind: "clipboard_read", label: "Clipboard", icon: "📋" },
];
const kindMeta = (k: PermKind) => KINDS.find((x) => x.kind === k) ?? { kind: k, label: "Other", icon: "•" };

const PermissionsPage: Component = () => {
  const [perms, setPerms] = createSignal<SitePerm[]>([]);
  const [newHost, setNewHost] = createSignal("");
  const [newKind, setNewKind] = createSignal<PermKind>("camera");
  const [newDecision, setNewDecision] = createSignal<PermDecision>("allow");

  const refresh = () => void permissionsList().then((p) => setPerms(p ?? [])).catch(() => {});
  onMount(() => {
    const id = activeId();
    if (id != null) updateTabTitle(id, "Site Permissions");
    refresh();
  });

  // Group remembered decisions by host.
  const byHost = createMemo(() => {
    const m = new Map<string, SitePerm[]>();
    for (const p of perms()) {
      if (!m.has(p.host)) m.set(p.host, []);
      m.get(p.host)!.push(p);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });

  const change = async (host: string, kind: PermKind, decision: PermDecision) => {
    await permissionsSet(host, kind, decision);
    refresh();
  };
  const clearHost = async (host: string) => {
    await permissionsClearHost(host);
    refresh();
  };
  const addRule = async () => {
    const host = newHost().trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!host) return;
    await permissionsSet(host, newKind(), newDecision());
    setNewHost("");
    refresh();
  };

  const DecisionPicker = (props: { value: PermDecision; onChange: (d: PermDecision) => void }) => (
    <div class="perm-seg">
      <For each={["allow", "ask", "deny"] as PermDecision[]}>
        {(d) => (
          <button
            classList={{ "perm-seg-btn": true, active: props.value === d, [d]: props.value === d }}
            onClick={() => props.onChange(d)}
          >
            {d === "allow" ? "Allow" : d === "deny" ? "Block" : "Ask"}
          </button>
        )}
      </For>
    </div>
  );

  return (
    <div class="hist-page">
      <header class="hist-head">
        <div class="hist-title">🔐 Site Permissions</div>
        <span class="res-mem">{perms().length} saved rule{perms().length === 1 ? "" : "s"}</span>
        <Show when={perms().length > 0}>
          <button class="hist-clear" onClick={() => void permissionsClearAll().then(refresh)}>Clear all</button>
        </Show>
      </header>

      <div class="hist-body">
        <div class="res-note">
          Camera, microphone, location, and notification access per site. A saved <b>Allow</b> or
          <b> Block</b> is applied automatically; <b>Ask</b> lets the page prompt you normally.
        </div>

        {/* Add a rule manually */}
        <div class="perm-add">
          <input
            class="perm-add-host"
            placeholder="example.com"
            value={newHost()}
            onInput={(e) => setNewHost(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && void addRule()}
          />
          <select class="shields-select" value={newKind()} onChange={(e) => setNewKind(e.currentTarget.value as PermKind)}>
            <For each={KINDS}>{(k) => <option value={k.kind}>{k.label}</option>}</For>
          </select>
          <select class="shields-select" value={newDecision()} onChange={(e) => setNewDecision(e.currentTarget.value as PermDecision)}>
            <option value="allow">Allow</option>
            <option value="deny">Block</option>
          </select>
          <button class="perm-add-btn" onClick={() => void addRule()}>Add</button>
        </div>

        <Show when={byHost().length > 0} fallback={<div class="hist-empty">No saved permissions yet.</div>}>
          <For each={byHost()}>
            {([host, rules]) => (
              <div class="perm-site">
                <div class="perm-site-head">
                  <span class="perm-site-host">{host}</span>
                  <button class="perm-site-clear" title="Forget this site" onClick={() => void clearHost(host)}>✕</button>
                </div>
                <For each={rules}>
                  {(r) => (
                    <div class="perm-rule">
                      <span class="perm-kind">{kindMeta(r.kind).icon} {kindMeta(r.kind).label}</span>
                      <DecisionPicker value={r.decision} onChange={(d) => void change(host, r.kind, d)} />
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
};

export default PermissionsPage;
