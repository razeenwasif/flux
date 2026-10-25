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
// Agent task steps (steps.rs): one control of each kind the engine tells
// apart. Typing is a draft, the card field is never typed into, the toggle and
// the dead button are drafts (one changes the page, one doesn't), the bank link
// is never followed, Send message is a commit that leaves the page and Place
// order is one Flux never clicks (#104).
const agentPage = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Flux Smoke — agent steps</title>
<style>body{font:18px system-ui;max-width:760px;margin:48px auto;padding:24px;background:#fafafa;color:#18202c}button,input,a{font:inherit;margin:8px;padding:8px}</style>
<h1>Agent steps</h1>
<label>Search <input id="q" name="q"></label>
<label>Card number <input id="card" name="card" autocomplete="cc-number"></label>
<p><button id="more" type="button" aria-expanded="false">More details</button> <button id="noop" type="button">Does nothing</button></p>
<p id="details" hidden>Delivery in 3–5 days.</p>
<p><a id="bank" href="https://www.commbank.com.au/">Pay from your bank</a></p>
<form action="/agent-done"><input type="hidden" name="msg" value="hello"><button id="send">Send message</button></form>
<p><button id="place" type="button">Place order</button></p>
<script>
document.querySelector('#more').onclick=(e)=>{const b=e.currentTarget;const open=b.getAttribute('aria-expanded')!=='true';b.setAttribute('aria-expanded',String(open));document.querySelector('#details').hidden=!open;};
</script></html>`;
// A sign-in Flux hands to you. The page lies about its password field (no
// size, not displayed) to its own scripts; Flux looks from a world of its own,
// so it still sees the field.
const signInPage = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Flux Smoke — sign in</title>
<style>body{font:18px system-ui;max-width:760px;margin:48px auto;padding:24px}input{font:inherit;margin:8px;padding:8px}</style>
<h1>Sign in</h1>
<label>Email <input id="user" name="user" autocomplete="username"></label>
<label>Password <input id="pw" name="pw" type="password" autocomplete="current-password"></label>
<script>
Element.prototype.getBoundingClientRect=()=>({x:0,y:0,width:0,height:0,top:0,left:0,right:0,bottom:0});
const real=window.getComputedStyle;window.getComputedStyle=(el)=>({...real(el),display:'none',visibility:'hidden'});
</script></html>`;
// Form help (formhelp.rs): a question in a plain div (as form builders write
// them), a textarea and a rich-text box, which get their answer copied, an answer
// already given, and fields form help never touches: email (a personal detail),
// a card number, and a sign-in form.
const formPage = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Flux Smoke — form help</title>
<style>body{font:17px system-ui;max-width:760px;margin:40px auto;padding:24px;background:#fafafa;color:#18202c}
.q{margin:18px 0}input,textarea,[contenteditable]{font:inherit;padding:8px;width:420px;border:1px solid #9aa;border-radius:6px;background:#fff;display:block;margin-top:6px}
[contenteditable]{min-height:60px}form{margin-top:24px;padding:12px;border:1px dashed #9aa}</style>
<h1>Volunteer sign-up</h1>
<div class="q"><label>Team <input id="team" name="team" value="Platform"></label></div>
<div class="q"><div>What's your favourite colour?</div><input id="colour" name="entry.1"></div>
<div class="q"><label>Why do you want to volunteer with us? <textarea id="why" name="why" rows="6"></textarea></label></div>
<div class="q"><div id="more-l">Anything else we should know?</div><div id="more" contenteditable="true" aria-labelledby="more-l"></div></div>
<div class="q"><label>Email <input id="email" name="email" type="email"></label></div>
<div class="q"><label>Card number <input id="card" name="card" autocomplete="cc-number"></label></div>
<form id="signin"><label>Login <input id="login" name="login"></label><label>Password <input id="pw" type="password"></label></form>
</html>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  res.setHeader("Cache-Control", "no-store");
  if (path === "/beat") {
    requests.push({ path, y: new URL(req.url, "http://127.0.0.1").searchParams.get("y"), at: new Date().toISOString() });
    res.end("ok");
  } else if (path === "/report") {
    const q = new URL(req.url, "http://127.0.0.1").searchParams;
    const promo = q.get("promo");
    requests.push({ path, promo, fh: q.get("fh"), v: q.get("v"), at: new Date().toISOString() });
    if (q.has("fh")) console.log(`Form help ${q.get("fh")}: ${q.get("v")}`);
    else console.log(`Page reported promo display: ${promo}`);
    res.end("ok");
  } else if (path === "/results") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(requests));
  } else if (path === "/flux-smoke-allowed.js" || path === "/flux-smoke-blocked.js") {
    requests.push({ path, at: new Date().toISOString() });
    console.log(`Resource reached server: ${path}`);
    res.setHeader("Content-Type", "text/javascript");
    res.end("/* Local smoke resource delivered successfully. */");
  } else if (path === "/agent" || path === "/agent-signin" || path === "/agent-done") {
    requests.push({ path, query: new URL(req.url, "http://127.0.0.1").search, at: new Date().toISOString() });
    if (path === "/agent-done") console.log(`Message sent: ${new URL(req.url, "http://127.0.0.1").search}`);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      path === "/agent"
        ? agentPage
        : path === "/agent-signin"
          ? signInPage
          : `<!doctype html><meta charset="utf-8"><title>Message sent</title><h1>Message sent</h1><a href="/agent">Back</a>`,
    );
  } else if (path === "/form") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(formPage);
  } else if (path === "/" || path === "/second") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(page(path === "/second"));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});
server.listen(8851, "127.0.0.1", () => console.log("Native smoke fixture: http://127.0.0.1:8851/"));
