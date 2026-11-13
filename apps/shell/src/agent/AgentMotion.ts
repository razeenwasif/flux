/**
 * The agent panel in motion, under Liquid Silk. Everything here is added around
 * the panel AgentPanel draws, so the panel itself stays as it is (and none of
 * this is in its startup code; the chunk loads when the panel first shows):
 *
 *  - a backdrop of grain gradient and dither behind the whole pane
 *    (silkBackdrop.ts), calmer at rest, livelier while the agent works;
 *  - a still field of dots across the bottom third that swells under the pointer;
 *  - a voice glow along the bottom edge: lobes of colour that rise with a
 *    voice and gather into one sweeping beam while the agent works;
 *  - a dot-matrix symbol beside the agent's name whose pattern says what it is
 *    doing, a status word that swaps softly, and bars on the mic while you talk;
 *  - a row that shimmers with what the agent is doing right now;
 *  - a rail of ticks beside the chat for jumping between messages;
 *  - a soft top-to-bottom reveal for an answer that arrives whole.
 *
 * Neither Fairy nor the local voice reports how loud it is, only that it is
 * speaking, so the glow and the symbol's level meter follow a speech-like
 * rhythm. Styles are in public/designs/liquid-silk.css (`.silk-…`).
 *
 * It all stops when the pane isn't showing or Flux isn't in front, and holds
 * still under Reduce Motion.
 */
import { createEffect, onCleanup, onMount, type Component } from "solid-js";

export type MotionState = "idle" | "listen" | "think" | "act" | "speak";

const TAU = Math.PI * 2;
/** rest · working · voice: which kind of backdrop a state gets. */
const GROUP: Record<MotionState, 0 | 1 | 2> = { idle: 0, listen: 0, think: 1, act: 1, speak: 2 };
const LABEL: Record<MotionState, string> = {
  idle: "Ready",
  listen: "Listening…",
  think: "Thinking…",
  act: "Working…",
  speak: "Speaking",
};
/** The symbol's pattern and pace per state; colours are filled in from the theme. */
const SYMBOL: Record<MotionState, [string, number]> = {
  idle: ["twinkle", 4200],
  listen: ["pulse", 1400],
  think: ["orbit", 1200],
  act: ["scan", 1100],
  speak: ["eq", 0],
};
const ORDER = [7, 2, 11, 5, 14, 9, 0, 12, 3, 15, 6, 10, 13, 1, 8, 4];
const RING = [1, 2, 7, 11, 14, 13, 8, 4];
const INNER = [5, 6, 9, 10];

const make = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  html = "",
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = cls;
  if (html) node.innerHTML = html;
  return node;
};
const cut = (text: string, limit: number): string => {
  if (text.length <= limit) return text;
  const part = text.slice(0, limit),
    at = part.lastIndexOf(" ");
  return `${part.slice(0, at > limit * 0.65 ? at : limit).trim()}…`;
};

const AgentMotion: Component<{
  root: () => HTMLElement;
  state: () => MotionState;
  /** What the agent is doing, when it says (an action's description). */
  detail: () => string;
}> = (props) => {
  onMount(() => {
    const root = props.root();
    const inner = root.querySelector<HTMLElement>(".agent-inner");
    const feed = root.querySelector<HTMLElement>(".agent-feed");
    if (!inner || !feed) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    const made: Element[] = [];
    const add = <T extends Element>(node: T): T => (made.push(node), node);
    const rgb = (name: string, fallback: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

    // ── Beside the name: the symbol and the status word ──
    const orb = root.querySelector<HTMLElement>(".agent-orb");
    const mx = add(make("span", "silk-mx"));
    orb?.classList.add("silk-has-mx");
    orb?.append(mx);
    const status = add(make("span", "silk-status"));
    root.querySelector(".agent-who")?.after(status);
    const symbol = (state: MotionState) => {
      const [variant, cycle] = SYMBOL[state];
      mx.style.setProperty("--mx-cycle", `${cycle}ms`);
      mx.style.setProperty(
        "--mx-on",
        state === "idle"
          ? "rgba(255,255,255,.62)"
          : `rgb(${state === "listen" || state === "act" ? rgb("--accent-rgb", "147,232,216") : rgb("--accent-ai-rgb", "210,156,246")})`,
      );
      mx.textContent = "";
      for (let i = 0; i < 16; i++) {
        const d = document.createElement("i");
        let delay: number | null = null;
        if (variant === "scan") delay = (i % 4) * (cycle / 10);
        else if (variant === "twinkle") delay = ORDER[i]! * (cycle / 16);
        else if (variant === "pulse") delay = INNER.includes(i) ? 0 : cycle * 0.16;
        else if (variant === "orbit") {
          const k = RING.indexOf(i);
          if (k >= 0) delay = k * (cycle / 8);
          else d.className = INNER.includes(i) ? "hold" : "rest";
        } else d.className = "eq";
        if (delay !== null) d.style.setProperty("--d", delay.toFixed(0));
        mx.append(d);
      }
    };
    /** Speaking: the symbol is a four-column level meter. */
    const meter = (level: number) => {
      const shape = [0.8, 1, 0.95, 0.7];
      for (let i = 0; i < mx.children.length; i++) {
        const n = Math.max(1, Math.round(level * (0.55 + 0.6 * Math.random()) * 4 * shape[i % 4]!));
        mx.children[i]!.classList.toggle("on", 3 - Math.floor(i / 4) < n);
      }
    };
    let swapT = 0;
    const say = (text: string) => {
      window.clearTimeout(swapT);
      if (reduce.matches || !status.textContent) {
        status.textContent = text;
        return;
      }
      status.classList.remove("is-enter-start");
      status.classList.add("is-exit");
      swapT = window.setTimeout(() => {
        status.textContent = text;
        status.classList.remove("is-exit");
        status.classList.add("is-enter-start");
        void status.offsetHeight;
        status.classList.remove("is-enter-start");
      }, 150);
    };

    // ── What it's doing right now, shimmering, above the tools ──
    const row = add(
      make(
        "div",
        "silk-thinking",
        '<b class="silk-dm"><u></u><u></u><u></u><u></u></b><span class="silk-shimmer on"></span>',
      ),
    );
    row.hidden = true;
    row.setAttribute("role", "status");
    root.querySelector(".agent-tools")?.before(row);

    // ── Bars on the mic while you talk (shown by `.agent-mic-on`) ──
    root
      .querySelector('.agent-input-row [aria-label="Hold to talk"]')
      ?.append(add(make("span", "silk-bars", "<i></i><i></i><i></i><i></i><i></i>")));

    // ── The message rail: a tick per message, a preview on hover ──
    const rail = add(make("nav", "silk-rail"));
    rail.setAttribute("aria-label", "Message navigation");
    rail.hidden = true;
    const peek = add(make("div", "silk-peek", "<b></b><span></span>"));
    inner.append(rail, peek);
    let msgs: HTMLElement[] = [];
    let activeTick = -1;
    const markActive = () => {
      if (rail.hidden || !msgs.length) return;
      const end = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
      let best = 0;
      if (feed.scrollTop <= 56) best = 0;
      else if (end <= 56) best = msgs.length - 1;
      else {
        const box = feed.getBoundingClientRect(),
          mid = box.top + box.height / 2;
        let near = Infinity;
        msgs.forEach((m, i) => {
          const r = m.getBoundingClientRect(),
            d = Math.abs(r.top + r.height / 2 - mid);
          if (d < near) ((near = d), (best = i));
        });
      }
      if (best === activeTick) return;
      activeTick = best;
      for (let i = 0; i < rail.children.length; i++) rail.children[i]!.classList.toggle("on", i === best);
    };
    const buildRail = () => {
      msgs = [...feed.querySelectorAll<HTMLElement>(".agent-msg.agent-user, .agent-msg.agent-assistant")];
      const needed = msgs.length > 1 && feed.scrollHeight > feed.clientHeight + 1;
      rail.hidden = !needed;
      feed.classList.toggle("silk-railed", needed);
      rail.textContent = "";
      activeTick = -1;
      if (!needed) return;
      Object.assign(rail.style, { top: `${feed.offsetTop}px`, height: `${feed.offsetHeight}px` });
      const tall = Math.max(4, Math.min(14, (feed.offsetHeight - 16) / msgs.length));
      msgs.forEach((m, i) => {
        const user = m.classList.contains("agent-user");
        const b = make("button", user ? "user" : "", "<i></i>");
        b.type = "button";
        b.style.height = `${tall}px`;
        b.setAttribute(
          "aria-label",
          `Go to ${user ? "your" : "the agent's"} message ${i + 1} of ${msgs.length}`,
        );
        const show = () => {
          const text = (m.textContent ?? "").replace(/\s+/g, " ").trim();
          const title = cut(text, 56);
          const reply = user
            ? msgs.slice(i + 1).find((x) => x.classList.contains("agent-assistant"))
            : undefined;
          const more =
            text.length > 56
              ? cut(text.slice(title.length - 1).trim(), 88)
              : reply
                ? cut((reply.textContent ?? "").replace(/\s+/g, " ").trim(), 88)
                : "";
          peek.firstElementChild!.textContent = title;
          peek.lastElementChild!.textContent = more;
          const y = rail.offsetTop + b.offsetTop + b.offsetHeight / 2;
          peek.style.top = `${Math.max(rail.offsetTop + 36, Math.min(rail.offsetTop + rail.offsetHeight - 36, y))}px`;
          peek.classList.add("show");
        };
        const hide = () => peek.classList.remove("show");
        b.addEventListener("pointerenter", show);
        b.addEventListener("focus", show);
        b.addEventListener("pointerleave", hide);
        b.addEventListener("blur", hide);
        b.addEventListener("click", () => {
          const smooth = reduce.matches ? "auto" : "smooth";
          if (i === msgs.length - 1) return feed.scrollTo({ top: feed.scrollHeight, behavior: smooth });
          const box = feed.getBoundingClientRect(),
            r = m.getBoundingClientRect();
          feed.scrollTo({
            top: feed.scrollTop + r.top - box.top - (feed.clientHeight - r.height) / 2,
            behavior: smooth,
          });
        });
        rail.append(b);
      });
      markActive();
    };
    let railT = 0;
    const scheduleRail = () => {
      if (railT) return;
      railT = window.setTimeout(() => ((railT = 0), buildRail()), 320);
    };
    feed.addEventListener("scroll", markActive, { passive: true });
    // New messages: rebuild the rail, and reveal an answer that arrived whole.
    let settled = false;
    window.setTimeout(() => (settled = true), 800);
    const feedMo = new MutationObserver((records) => {
      scheduleRail();
      if (!settled || reduce.matches) return;
      const added = records
        .flatMap((r) => [...r.addedNodes])
        .filter((n): n is HTMLElement => n instanceof HTMLElement);
      const answers = added.filter((n) => n.matches(".agent-msg.agent-assistant"));
      // A chat being reopened adds many at once; only a fresh answer gets it.
      if (answers.length !== 1 || added.length > 3) return;
      const one = answers[0]!,
        len = (one.textContent ?? "").length;
      if (len < 40) return; // being streamed in token by token already
      one.style.setProperty("--silk-reveal", `${Math.max(500, Math.min(2400, len * 12))}ms`);
      one.classList.add("silk-reveal");
      one.addEventListener("animationend", () => one.classList.remove("silk-reveal"), { once: true });
    });
    feedMo.observe(feed, { childList: true, subtree: true, characterData: true });
    const feedRo = new ResizeObserver(scheduleRail);
    feedRo.observe(feed);
    scheduleRail();

    // ── Behind the pane: backdrop, glow; above it: the dots ──
    const host = add(make("div", "silk-ambience"));
    const back = make("div", "silk-back");
    const glowCv = make("canvas", "silk-glow");
    host.append(back, glowCv);
    host.setAttribute("aria-hidden", "true");
    const dotsCv = add(make("canvas", "silk-dots"));
    dotsCv.setAttribute("aria-hidden", "true");
    const gctx = glowCv.getContext("2d"),
      dctx = dotsCv.getContext("2d");
    let side: HTMLElement | null = null;
    let dpr = 1,
      GW = 0,
      GH = 0,
      DW = 0,
      DH = 0;
    const size = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      GW = glowCv.offsetWidth;
      GH = glowCv.offsetHeight;
      DW = dotsCv.offsetWidth;
      DH = dotsCv.offsetHeight;
      glowCv.width = Math.round(GW * dpr);
      glowCv.height = Math.round(GH * dpr);
      dotsCv.width = Math.round(DW * dpr);
      dotsCv.height = Math.round(DH * dpr);
    };
    const ro = new ResizeObserver(() => {
      size();
      if (raf) drawDots(false);
      else still();
    });
    /** The pane is the sidebar card when the agent is docked there. */
    const place = () => {
      const s = root.closest<HTMLElement>(".sidebar");
      const target = s ?? root.querySelector<HTMLElement>(".agent-fx") ?? inner;
      if (host.parentElement === target) return;
      side?.removeEventListener("pointermove", onMove);
      side?.removeEventListener("pointerleave", onLeave);
      side = s ?? inner;
      side.addEventListener("pointermove", onMove, { passive: true });
      side.addEventListener("pointerleave", onLeave);
      target.append(host, dotsCv);
      ro.disconnect();
      ro.observe(host);
      size();
    };

    // The backdrop's shaders load on their own; the rest doesn't wait for them.
    let backdrop: { set: (pace: number, show: number) => void; dispose: () => void } | null = null;
    let gone = false;
    const pace = () => {
      const g = GROUP[props.state()];
      backdrop?.set(raf ? [0.45, 1.25, 0.8][g]! : 0, [0.33, 0.5, 0.42][g]!);
    };
    void import("./silkBackdrop")
      .then((m) => m.mountSilkBackdrop(back))
      .then((b) => {
        if (gone) return b.dispose();
        backdrop = b;
        pace();
      })
      .catch((err) => console.warn("[agent-motion] no backdrop:", err));

    // Speech: syllables of 90–240 ms, short gaps, longer pauses between phrases.
    let env = 0,
      slow = 0,
      target = 0,
      nextAt = 0;
    const voice = (t: number) => {
      if (t >= nextAt) {
        const r = Math.random();
        if (r < 0.12) ((target = 0.05), (nextAt = t + 260 + Math.random() * 380));
        else if (r < 0.35) ((target = 0.2), (nextAt = t + 50 + Math.random() * 70));
        else ((target = 0.55 + Math.random() * 0.45), (nextAt = t + 90 + Math.random() * 150));
      }
      env += (target - env) * (target > env ? 0.35 : 0.12);
      slow += (env - slow) * 0.035;
    };
    const seeds = Array.from({ length: 64 }, () => Math.random());
    const noise = (x: number) => {
      const i = Math.floor(x),
        f = x - i;
      const a = seeds[((i % 64) + 64) % 64]!,
        b = seeds[(((i + 1) % 64) + 64) % 64]!;
      return a + (b - a) * f * f * (3 - 2 * f);
    };

    // The dots: a grid; the ones near the pointer swell and lean away from it.
    // `on` is how much the cluster shows: it swells in under the pointer and
    // settles back to a plain, still grid when the pointer leaves.
    const ptr = { x: 0, y: 0, tx: 0, ty: 0, inside: false, on: 0 };
    function onMove(e: PointerEvent) {
      const r = dotsCv.getBoundingClientRect();
      const x = e.clientX - r.left,
        y = e.clientY - r.top;
      ptr.inside = x >= 0 && x <= r.width && y >= 0 && y <= r.height;
      if (ptr.inside) ((ptr.tx = x), (ptr.ty = y));
    }
    function onLeave() {
      ptr.inside = false;
    }
    const GAP = 10;
    const drawDots = (moving: boolean) => {
      if (!dctx || !DW) return;
      dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dctx.clearRect(0, 0, DW, DH);
      if (!moving) ptr.on = 0;
      else ptr.on += ((ptr.inside ? 1 : 0) - ptr.on) * (ptr.inside ? 0.14 : 0.08);
      if (ptr.on < 0.004) ptr.on = 0;
      // Arriving, the cluster starts where the pointer is; then it follows.
      const follow = ptr.on < 0.05 ? 1 : 0.16;
      ptr.x += (ptr.tx - ptr.x) * follow;
      ptr.y += (ptr.ty - ptr.y) * follow;
      const radius = Math.min(DW, DH) * 0.52;
      const cols = Math.ceil(DW / GAP) + 1,
        rows = Math.ceil(DH / GAP) + 1;
      const ox = (DW - (cols - 1) * GAP) / 2,
        oy = (DH - (rows - 1) * GAP) / 2;
      dctx.fillStyle = "#e9f6f2";
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const ax = ox + c * GAP,
            ay = oy + r * GAP;
          const dx = ax - ptr.x,
            dy = ay - ptr.y,
            dist = Math.hypot(dx, dy);
          const near = Math.max(0, 1 - dist / radius),
            inf = near * near * (3 - 2 * near) * ptr.on;
          const push = inf * inf * 9;
          dctx.globalAlpha = 0.17 + inf * 0.5;
          dctx.beginPath();
          dctx.arc(
            ax + (dist ? dx / dist : 0) * push,
            ay + (dist ? dy / dist : 0) * push,
            0.85 + inf,
            0,
            TAU,
          );
          dctx.fill();
        }
      dctx.globalAlpha = 1;
    };

    // The glow: five lobes on the bottom edge. The centre follows the low end
    // of the voice, its neighbours the middle, the outer pair the highs, and
    // they slide sideways while a voice is heard. While the agent works they
    // gather into one beam that sweeps across and back.
    let lobes: string[] = [];
    const glow = { level: 0, proc: 0, flow: 0, sweep: 0 };
    const lobe = (x: number, y: number, rx: number, ry: number, colour: string, a: number) => {
      if (!gctx || a <= 0.003) return;
      gctx.save();
      gctx.translate(x, y);
      gctx.scale(rx, ry);
      const g = gctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, `rgba(${colour},${a})`);
      g.addColorStop(1, `rgba(${colour},0)`);
      gctx.fillStyle = g;
      gctx.beginPath();
      gctx.arc(0, 0, 1, 0, TAU);
      gctx.fill();
      gctx.restore();
    };
    const drawGlow = (dt: number, t: number, state: MotionState) => {
      if (!gctx || !GW) return;
      const voiced = state === "speak" || state === "listen",
        working = state === "think" || state === "act";
      const want = voiced ? Math.max(0.1, env) : working ? 0.55 : 0;
      glow.level += (want - glow.level) * (want > glow.level ? 0.25 : 0.06);
      glow.proc += ((working ? 1 : 0) - glow.proc) * 0.05;
      glow.flow += dt * 80 * glow.level * (1 - glow.proc);
      glow.sweep += dt;
      gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      gctx.clearRect(0, 0, GW, GH);
      const L = glow.level;
      if (L < 0.01) return;
      const cx = GW / 2,
        range = GW * 0.42,
        gap = GW * 0.16;
      const ph = (glow.sweep / 1.1) % 2,
        lin = ph < 1 ? ph : 2 - ph;
      const eased = lin < 0.5 ? Math.pow(lin * 2, 2.1) / 2 : 1 - Math.pow((1 - lin) * 2, 2.1) / 2;
      const sweep = (eased * 2 - 1) * range * 0.7 * glow.proc;
      const bands = [
        env * (0.55 + 0.45 * noise(t * 9)),
        env,
        slow * 1.25,
        env,
        env * (0.55 + 0.45 * noise(t * 9 + 20)),
      ];
      const calm = 1 - 0.6 * glow.proc; // gathered into one beam, the lobes add up
      gctx.globalCompositeOperation = "lighter";
      lobes.forEach((colour, i) => {
        let x = (i - 2) * gap + (glow.flow % (5 * gap));
        if (x > 2.5 * gap) x -= 5 * gap;
        x = x * (1 - glow.proc) + (i - 2) * gap * 0.16 * glow.proc;
        const bell = Math.exp(-Math.pow(Math.abs(x) / (range * 0.8), 2)); // quiet toward the ends
        const b = voiced ? L * 0.4 + Math.min(1, bands[i]!) * 0.6 : L;
        const rx = gap * (0.85 + 0.55 * L),
          ry = (18 + 200 * b) * (0.5 + 0.5 * bell);
        lobe(cx + x + sweep, GH, rx * 1.7, ry * 1.6, colour, 0.3 * bell * L * calm); // bloom
        lobe(cx + x + sweep, GH, rx, ry, colour, 0.8 * bell * (0.3 + 0.7 * b) * calm); // inner light
      });
      // The lit edge, and a faint rim tracing the hump the glow rises to.
      const edge = gctx.createLinearGradient(cx - range + sweep, 0, cx + range + sweep, 0);
      edge.addColorStop(0, "rgba(255,255,255,0)");
      edge.addColorStop(0.5, `rgba(255,255,255,${0.75 * L})`);
      edge.addColorStop(1, "rgba(255,255,255,0)");
      gctx.fillStyle = edge;
      gctx.fillRect(0, GH - 2, GW, 2);
      const ceil = (8 + 62 * L) * (1 - glow.proc * 0.55),
        wide = range * (0.55 - 0.3 * glow.proc);
      gctx.beginPath();
      for (let x = -range; x <= range; x += 5) {
        const y = GH - 2 - ceil * Math.exp(-Math.pow(Math.abs(x - sweep) / wide, 1.75));
        if (x === -range) gctx.moveTo(cx + x, y);
        else gctx.lineTo(cx + x, y);
      }
      gctx.strokeStyle = `rgba(255,255,255,${0.26 * L})`;
      gctx.lineWidth = 1.2;
      gctx.stroke();
      gctx.globalCompositeOperation = "source-over";
    };

    // ── One loop, only while the pane shows and Flux is in front ──
    let raf = 0,
      last = 0,
      drawn = 0,
      meterAt = 0,
      visible = false;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const state = props.state();
      if (now - drawn < 15) return;
      const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
      last = drawn = now;
      voice(now);
      // The grid is still unless the pointer is on it (or it's settling back).
      if (ptr.inside || ptr.on > 0) drawDots(true);
      drawGlow(dt, now / 1000, state);
      if (state === "speak" && now - meterAt > 70) ((meterAt = now), meter(env));
    };
    /** One still frame: the dots at rest, no glow. */
    const still = () => {
      drawDots(false);
      if (gctx && GW) {
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        gctx.clearRect(0, 0, GW, GH);
      }
    };
    const sync = () => {
      const run = visible && !reduce.matches && !document.hidden && document.hasFocus();
      host.hidden = dotsCv.hidden = !visible;
      if (visible) place();
      if (run && !raf) {
        lobes = [
          "61,111,214",
          rgb("--accent-rgb", "147,232,216"),
          "236,244,255",
          rgb("--accent-ai-rgb", "210,156,246"),
          rgb("--accent-hot-rgb", "240,176,226"),
        ];
        last = 0;
        drawDots(false); // the grid at rest; the loop only redraws it under the pointer
        raf = requestAnimationFrame(frame);
      } else if (!run && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
        glow.level = glow.proc = 0;
      }
      if (!run && visible) still();
      pace();
    };
    const io = new IntersectionObserver((entries) => {
      visible = entries[entries.length - 1]!.isIntersecting;
      sync();
    });
    io.observe(root);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    reduce.addEventListener("change", sync);

    createEffect(() => {
      const state = props.state();
      symbol(state);
      say(LABEL[state]);
      const working = state === "think" || state === "act";
      status.classList.toggle("silk-shimmer", working);
      status.classList.toggle("on", working);
      row.hidden = !working;
      if (working) row.lastElementChild!.textContent = props.detail() || LABEL[state];
      pace();
    });

    onCleanup(() => {
      gone = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(swapT);
      window.clearTimeout(railT);
      io.disconnect();
      ro.disconnect();
      feedMo.disconnect();
      feedRo.disconnect();
      feed.removeEventListener("scroll", markActive);
      feed.classList.remove("silk-railed");
      side?.removeEventListener("pointermove", onMove);
      side?.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      reduce.removeEventListener("change", sync);
      backdrop?.dispose();
      orb?.classList.remove("silk-has-mx");
      for (const node of made) node.remove();
    });
  });
  return null;
};

export default AgentMotion;
