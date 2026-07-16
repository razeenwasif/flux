/**
 * Calculator widget (#130) — a compact calc on the home page that expands into a
 * full scientific calculator. Self-contained: a small safe recursive-descent
 * evaluator (no eval/Function) supporting + − × ÷ ^ % parens, unary minus,
 * factorial, the usual functions (sin/cos/tan/asin/acos/atan/ln/log/sqrt/abs/exp)
 * and constants (π, e, ans). DEG/RAD toggle for trig.
 */
import { For, Show, createMemo, createSignal, type Component } from "solid-js";

// ── Safe expression evaluator ────────────────────────────────────────────────
type Tok = { t: "num"; v: number } | { t: "name"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const s = src
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/−/g, "-")
    .replace(/π/g, "pi")
    .replace(/√/g, "sqrt");
  while (i < s.length) {
    const c = s[i]!;
    if (c === " ") {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (
        j < s.length &&
        /[0-9.eE]/.test(s[j]!) &&
        !(/[eE]/.test(s[j]!) && !/[0-9.]/.test(s[j + 1] ?? ""))
      ) {
        // allow 1e3 but not a trailing 'e' that's the constant
        if (/[eE]/.test(s[j]!) && !/[-+0-9]/.test(s[j + 1] ?? "")) break;
        j++;
      }
      out.push({ t: "num", v: Number(s.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[a-zA-Z]/.test(s[j]!)) j++;
      out.push({ t: "name", v: s.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if ("+-*/^%()!".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new Error("bad char");
  }
  return out;
}

const FN: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  ln: Math.log,
  log: Math.log10,
  exp: Math.exp,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
};
const TRIG_IN = new Set(["sin", "cos", "tan"]);
const TRIG_OUT = new Set(["asin", "acos", "atan"]);

function evaluate(src: string, deg: boolean, ans: number): number {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = () => toks[p++];
  const fact = (n: number): number => {
    if (n < 0 || n % 1 !== 0 || n > 170) return NaN;
    let r = 1;
    for (let k = 2; k <= n; k++) r *= k;
    return r;
  };

  function parseExpr(): number {
    let v = parseTerm();
    for (;;) {
      const o = peek();
      if (o?.t === "op" && (o.v === "+" || o.v === "-")) {
        eat();
        const r = parseTerm();
        v = o.v === "+" ? v + r : v - r;
      } else break;
    }
    return v;
  }
  function parseTerm(): number {
    let v = parsePower();
    for (;;) {
      const o = peek();
      if (o?.t === "op" && (o.v === "*" || o.v === "/" || o.v === "%")) {
        eat();
        const r = parsePower();
        v = o.v === "*" ? v * r : o.v === "/" ? v / r : v % r;
      } else break;
    }
    return v;
  }
  function parsePower(): number {
    const b = parseUnary();
    const o = peek();
    if (o?.t === "op" && o.v === "^") {
      eat();
      return Math.pow(b, parsePower());
    } // right-assoc
    return b;
  }
  function parseUnary(): number {
    const o = peek();
    if (o?.t === "op" && (o.v === "-" || o.v === "+")) {
      eat();
      const v = parseUnary();
      return o.v === "-" ? -v : v;
    }
    return parsePostfix();
  }
  function parsePostfix(): number {
    let v = parsePrimary();
    for (;;) {
      const o = peek();
      if (o?.t === "op" && o.v === "!") {
        eat();
        v = fact(v);
      } else break;
    }
    return v;
  }
  function parsePrimary(): number {
    const o = eat();
    if (!o) throw new Error("unexpected end");
    if (o.t === "num") return o.v;
    if (o.t === "op" && o.v === "(") {
      const v = parseExpr();
      const c = eat();
      if (!(c?.t === "op" && c.v === ")")) throw new Error("expected )");
      return v;
    }
    if (o.t === "name") {
      if (o.v === "pi") return Math.PI;
      if (o.v === "e") return Math.E;
      if (o.v === "ans") return ans;
      const fn = FN[o.v];
      if (fn) {
        const n = eat();
        if (!(n?.t === "op" && n.v === "(")) throw new Error("expected (");
        let arg = parseExpr();
        const c = eat();
        if (!(c?.t === "op" && c.v === ")")) throw new Error("expected )");
        if (deg && TRIG_IN.has(o.v)) arg = (arg * Math.PI) / 180;
        let r = fn(arg);
        if (deg && TRIG_OUT.has(o.v)) r = (r * 180) / Math.PI;
        return r;
      }
      throw new Error(`unknown ${o.v}`);
    }
    throw new Error("unexpected token");
  }
  const result = parseExpr();
  if (p !== toks.length) throw new Error("trailing input");
  return result;
}

// ── Component ────────────────────────────────────────────────────────────────
const fmtResult = (n: number): string => {
  if (!Number.isFinite(n)) return "Error";
  if (Math.abs(n) >= 1e12 || (n !== 0 && Math.abs(n) < 1e-6))
    return n.toExponential(6).replace(/\.?0+e/, "e");
  return String(Math.round(n * 1e10) / 1e10);
};

const Calculator: Component<{ scientific?: boolean }> = (props) => {
  const [expr, setExpr] = createSignal("");
  const [deg, setDeg] = createSignal(true);
  let ans = 0;

  const preview = createMemo(() => {
    const e = expr().trim();
    if (!e) return "";
    try {
      const v = evaluate(e, deg(), ans);
      return Number.isFinite(v) ? fmtResult(v) : "";
    } catch {
      return "";
    }
  });

  const push = (s: string) => setExpr((e) => e + s);
  const clear = () => setExpr("");
  const back = () => setExpr((e) => e.slice(0, -1));
  const equals = () => {
    const e = expr().trim();
    if (!e) return;
    try {
      const v = evaluate(e, deg(), ans);
      if (Number.isFinite(v)) {
        ans = v;
        setExpr(fmtResult(v));
      } else setExpr("Error");
    } catch {
      setExpr("Error");
    }
  };

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Enter" || ev.key === "=") {
      ev.preventDefault();
      equals();
    } else if (ev.key === "Escape") clear();
    else if (ev.key === "Backspace") {
      ev.preventDefault();
      back();
    } else if (/^[0-9+\-*/^%().]$/.test(ev.key)) {
      ev.preventDefault();
      if (expr() === "Error") setExpr(ev.key);
      else push(ev.key);
    }
  };

  const tap = (s: string) => {
    if (expr() === "Error") setExpr("");
    push(s);
  };

  const SCI: { l: string; s: string }[][] = [
    [
      { l: "sin", s: "sin(" },
      { l: "cos", s: "cos(" },
      { l: "tan", s: "tan(" },
      { l: "π", s: "π" },
      { l: "e", s: "e" },
    ],
    [
      { l: "ln", s: "ln(" },
      { l: "log", s: "log(" },
      { l: "√", s: "√(" },
      { l: "x²", s: "^2" },
      { l: "xʸ", s: "^" },
    ],
    [
      { l: "asin", s: "asin(" },
      { l: "acos", s: "acos(" },
      { l: "atan", s: "atan(" },
      { l: "n!", s: "!" },
      { l: "ans", s: "ans" },
    ],
  ];

  return (
    <div classList={{ calc: true, "calc-sci": !!props.scientific }} tabindex={0} onKeyDown={onKey}>
      <div class="calc-display">
        <input
          class="calc-expr"
          value={expr()}
          placeholder="0"
          spellcheck={false}
          onInput={(e) => setExpr(e.currentTarget.value)}
        />
        <div class="calc-preview">{preview() && preview() !== expr() ? `= ${preview()}` : ""}</div>
      </div>
      <Show when={props.scientific}>
        <div class="calc-sci-head">
          <button classList={{ "calc-deg": true, on: deg() }} onClick={() => setDeg(true)}>
            DEG
          </button>
          <button classList={{ "calc-deg": true, on: !deg() }} onClick={() => setDeg(false)}>
            RAD
          </button>
        </div>
        <For each={SCI}>
          {(row) => (
            <div class="calc-row calc-row-sci">
              <For each={row}>
                {(b) => (
                  <button class="calc-btn calc-fn" onClick={() => tap(b.s)}>
                    {b.l}
                  </button>
                )}
              </For>
            </div>
          )}
        </For>
      </Show>
      <div class="calc-grid">
        <button class="calc-btn calc-clear" onClick={clear}>
          C
        </button>
        <button class="calc-btn calc-op" onClick={() => tap("(")}>
          (
        </button>
        <button class="calc-btn calc-op" onClick={() => tap(")")}>
          )
        </button>
        <button class="calc-btn calc-op" onClick={() => tap("%")}>
          %
        </button>
        <button class="calc-btn calc-op" onClick={() => tap("÷")}>
          ÷
        </button>

        <button class="calc-btn" onClick={() => tap("7")}>
          7
        </button>
        <button class="calc-btn" onClick={() => tap("8")}>
          8
        </button>
        <button class="calc-btn" onClick={() => tap("9")}>
          9
        </button>
        <button class="calc-btn calc-back" onClick={back}>
          ⌫
        </button>
        <button class="calc-btn calc-op" onClick={() => tap("×")}>
          ×
        </button>

        <button class="calc-btn" onClick={() => tap("4")}>
          4
        </button>
        <button class="calc-btn" onClick={() => tap("5")}>
          5
        </button>
        <button class="calc-btn" onClick={() => tap("6")}>
          6
        </button>
        <button class="calc-btn calc-op" onClick={() => tap("−")}>
          −
        </button>
        <button class="calc-btn calc-op" onClick={() => tap("+")}>
          +
        </button>

        <button class="calc-btn" onClick={() => tap("1")}>
          1
        </button>
        <button class="calc-btn" onClick={() => tap("2")}>
          2
        </button>
        <button class="calc-btn" onClick={() => tap("3")}>
          3
        </button>
        <button class="calc-btn" onClick={() => tap("0")}>
          0
        </button>
        <button class="calc-btn calc-eq" onClick={equals}>
          =
        </button>

        <button class="calc-btn" onClick={() => tap(".")}>
          .
        </button>
        <button class="calc-btn calc-op" onClick={() => tap("^")}>
          ^
        </button>
        <button class="calc-btn calc-op" onClick={() => tap("π")}>
          π
        </button>
        <button class="calc-btn calc-op" onClick={() => tap("√(")}>
          √
        </button>
      </div>
    </div>
  );
};

export default Calculator;
