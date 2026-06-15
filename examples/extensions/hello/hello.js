// Hello Flux — a minimal content script that exercises the flux.* broker API
// (BACKLOG #94). `flux` is injected ahead of this script by the broker and is
// grant-checked per call; this extension requests dom:read/dom:write + storage.
(async () => {
  // Per-extension persisted KV (flux.storage, granted by "storage").
  let count = 0;
  try {
    count = (Number(await flux.storage.get("visits")) || 0) + 1;
    await flux.storage.set("visits", count);
  } catch (e) {
    console.warn("[flux hello] storage unavailable:", e);
  }

  const badge = document.createElement("div");
  badge.id = "flux-hello-badge";
  badge.textContent = `👋 Hello from a Flux extension · visit #${count}`;
  document.documentElement.appendChild(badge);
  setTimeout(() => badge.remove(), 4000);
})();
