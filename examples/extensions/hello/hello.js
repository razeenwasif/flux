// Hello Flux — a minimal content script (BACKLOG #93 will inject this into the
// page after the manifest is loaded by #92). Until the `flux.*` broker API (#94)
// is wired, content scripts run in the page world and may touch the DOM only.
(() => {
  const badge = document.createElement("div");
  badge.id = "flux-hello-badge";
  badge.textContent = "👋 Hello from a Flux extension";
  document.documentElement.appendChild(badge);
  setTimeout(() => badge.remove(), 4000);
})();
