import { createServer } from "node:http";

// Both resources exist and succeed without Shields. A native-smoke build adds
// one synthetic rule for the blocked resource, using the production translator.
const requests = [];
const page = (second) => `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Flux Smoke ${second ? "B" : "A"}</title>
<style>body{font:18px system-ui;max-width:760px;margin:48px auto;padding:24px;background:#fafafa;color:#18202c}button,input,a{font:inherit;margin:8px;padding:8px}#results{padding:16px;background:#e5eaf0;white-space:pre-wrap}</style>
<h1>Native browser smoke test — ${second ? "B" : "A"}</h1>
<p>This page and both test resources are served only on this computer.</p>
<a href="/${second ? "" : "second"}">Go to page ${second ? "A" : "B"}</a>
<button id="title">Change title after load</button>
<label>Unsaved page text <input id="draft" placeholder="Type a persistence marker"></label>
<button id="probe">Run blocking probe</button>
<pre id="results" role="status">Probe not run.</pre>
<div id="promo" class="promo" style="padding:16px;margin-top:16px;background:#ffe8a3">A pretend promo box, for Shields → Hide an element.</div>
<script>
document.querySelector('#title').onclick=()=>{document.title='Flux Smoke ${second ? "B" : "A"} — Updated';};
const probe=async()=>{
 const run=(path)=>new Promise(resolve=>{const s=document.createElement('script');s.src=path+'?run='+Date.now();s.onload=()=>resolve('loaded');s.onerror=()=>resolve('blocked or failed');document.head.append(s);});
 const allowed=await run('/flux-smoke-allowed.js');
 const blocked=await run('/flux-smoke-blocked.js');
 document.querySelector('#results').textContent='Allowed resource: '+allowed+'\\nBlocked resource: '+blocked+'\\nCheck the server request log to distinguish blocking from a server failure.';
};
document.querySelector('#probe').onclick=probe;
// ?auto runs the probe on load, for a check without clicking.
if(location.search.includes('auto'))probe();
// ?beat sends a heartbeat every half second: it stops while Flux has the page
// suspended (tab sleep) and starts again from the page's restored state.
if(location.search.includes('beat')){document.body.style.minHeight='4000px';setInterval(()=>fetch('/beat?y='+Math.round(scrollY)),500);}
// Whether the promo box shows, once Flux has injected its cosmetic CSS: logged
// by the server, for the Hide-an-element check.
setTimeout(()=>fetch('/report?promo='+getComputedStyle(document.querySelector('#promo')).display),800);
</script></html>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  res.setHeader("Cache-Control", "no-store");
  if (path === "/beat") {
    requests.push({ path, y: new URL(req.url, "http://127.0.0.1").searchParams.get("y"), at: new Date().toISOString() });
    res.end("ok");
  } else if (path === "/report") {
    const promo = new URL(req.url, "http://127.0.0.1").searchParams.get("promo");
    requests.push({ path, promo, at: new Date().toISOString() });
    console.log(`Page reported promo display: ${promo}`);
    res.end("ok");
  } else if (path === "/results") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(requests));
  } else if (path === "/flux-smoke-allowed.js" || path === "/flux-smoke-blocked.js") {
    requests.push({ path, at: new Date().toISOString() });
    console.log(`Resource reached server: ${path}`);
    res.setHeader("Content-Type", "text/javascript");
    res.end("/* Local smoke resource delivered successfully. */");
  } else if (path === "/" || path === "/second") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(page(path === "/second"));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});
server.listen(8851, "127.0.0.1", () => console.log("Native smoke fixture: http://127.0.0.1:8851/"));
