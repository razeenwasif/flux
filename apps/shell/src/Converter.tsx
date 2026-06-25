/**
 * Unit converter widget (#130) — length / mass / temperature / volume / area /
 * speed / time / data, plus a live **currency** converter (ECB rates via the
 * `currency_rates` backend command, fetched on demand + cached per base).
 * One compact UI; `full` just gives it more room in the expanded modal.
 */
import { For, Show, createMemo, createResource, createSignal, type Component } from "solid-js";

import { currencyRates } from "./ipc";

type Cat = { name: string; units: Record<string, number>; temp?: boolean; currency?: boolean };

// Factors are "base units per 1 unit"; convert via value*from / to. Temp + currency special-cased.
const CATS: Cat[] = [
  { name: "Length", units: { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254, nmi: 1852 } },
  { name: "Mass", units: { kg: 1, g: 0.001, mg: 1e-6, t: 1000, lb: 0.45359237, oz: 0.028349523125, st: 6.35029318 } },
  { name: "Temp", units: { "°C": 1, "°F": 1, K: 1 }, temp: true },
  { name: "Volume", units: { L: 1, mL: 0.001, "m³": 1000, "gal": 3.785411784, qt: 0.946352946, pt: 0.473176473, cup: 0.2365882365, "fl oz": 0.0295735295625, tbsp: 0.01478676478, tsp: 0.00492892159 } },
  { name: "Area", units: { "m²": 1, "km²": 1e6, "cm²": 1e-4, ha: 1e4, "ft²": 0.09290304, "yd²": 0.83612736, acre: 4046.8564224, "mi²": 2589988.110336 } },
  { name: "Speed", units: { "m/s": 1, "km/h": 0.277777778, mph: 0.44704, knot: 0.514444444, "ft/s": 0.3048 } },
  { name: "Time", units: { sec: 1, min: 60, hour: 3600, day: 86400, week: 604800, ms: 0.001, year: 31557600 } },
  { name: "Data", units: { B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776, bit: 0.125 } },
  { name: "Currency", units: {}, currency: true },
];

// frankfurter.app's supported codes (ECB).
const CURRENCIES = ["AUD", "USD", "EUR", "GBP", "JPY", "CAD", "CHF", "CNY", "INR", "NZD", "SGD", "HKD", "SEK", "NOK", "DKK", "KRW", "MXN", "BRL", "ZAR", "PLN", "THB", "IDR", "MYR", "PHP", "TRY", "CZK", "HUF", "ILS", "ISK", "RON", "BGN"];

const toBaseTemp = (v: number, u: string) => (u === "°C" ? v : u === "°F" ? (v - 32) * (5 / 9) : v - 273.15); // → °C
const fromBaseTemp = (c: number, u: string) => (u === "°C" ? c : u === "°F" ? c * (9 / 5) + 32 : c + 273.15);

const fmt = (n: number): string => {
  if (!Number.isFinite(n)) return "—";
  if (n !== 0 && (Math.abs(n) >= 1e12 || Math.abs(n) < 1e-6)) return n.toExponential(4);
  return String(Math.round(n * 1e6) / 1e6);
};

const Converter: Component<{ full?: boolean }> = (props) => {
  const [catName, setCatName] = createSignal("Length");
  const cat = () => CATS.find((c) => c.name === catName())!;
  const [amount, setAmount] = createSignal("1");
  const [from, setFrom] = createSignal("m");
  const [to, setTo] = createSignal("ft");

  // Currency rates, fetched per `from` code and cached by createResource keyed on it.
  const [rates] = createResource(
    () => (cat().currency ? from() : null),
    async (base) => (base ? currencyRates(base).catch(() => null) : null),
  );

  const unitList = () => (cat().currency ? CURRENCIES : Object.keys(cat().units));

  // When the category changes, reset the unit pickers to that category's first two.
  const pickCat = (name: string) => {
    setCatName(name);
    const c = CATS.find((x) => x.name === name)!;
    if (c.currency) { setFrom("AUD"); setTo("USD"); }
    else { const ks = Object.keys(c.units); setFrom(ks[0]!); setTo(ks[1] ?? ks[0]!); }
  };

  const result = createMemo(() => {
    const v = Number(amount());
    if (!Number.isFinite(v)) return "—";
    const c = cat();
    if (c.temp) return fmt(fromBaseTemp(toBaseTemp(v, from()), to()));
    if (c.currency) {
      const r = rates();
      if (!r) return rates.loading ? "…" : "—";
      const rf = r.rates[from()] ?? (from() === r.base ? 1 : undefined);
      const rt = r.rates[to()];
      if (rf == null || rt == null) return "—";
      return fmt((v / rf) * rt);
    }
    return fmt((v * c.units[from()]!) / c.units[to()]!);
  });

  const swap = () => { const f = from(); setFrom(to()); setTo(f); };

  return (
    <div classList={{ conv: true, "conv-full": !!props.full }}>
      <Show
        when={props.full}
        fallback={
          <select class="conv-cat-sel" value={catName()} onChange={(e) => pickCat(e.currentTarget.value)}>
            <For each={CATS}>{(c) => <option value={c.name}>{c.name}</option>}</For>
          </select>
        }
      >
        <div class="conv-tabs">
          <For each={CATS}>{(c) => <button classList={{ "conv-tab": true, on: c.name === catName() }} onClick={() => pickCat(c.name)}>{c.name}</button>}</For>
        </div>
      </Show>

      <div class="conv-body">
        <div class="conv-side">
          <input class="conv-amt" inputmode="decimal" value={amount()} onInput={(e) => setAmount(e.currentTarget.value)} spellcheck={false} />
          <select class="conv-unit" value={from()} onChange={(e) => setFrom(e.currentTarget.value)}>
            <For each={unitList()}>{(u) => <option value={u}>{u}</option>}</For>
          </select>
        </div>
        <button class="conv-swap" title="Swap" onClick={swap}>⇅</button>
        <div class="conv-side">
          <div class="conv-result" title={result()}>{result()}</div>
          <select class="conv-unit" value={to()} onChange={(e) => setTo(e.currentTarget.value)}>
            <For each={unitList()}>{(u) => <option value={u}>{u}</option>}</For>
          </select>
        </div>
      </div>

      <Show when={cat().currency}>
        <div class="conv-note">
          {rates.loading ? "Fetching live rates…" : rates() ? `ECB rates · ${rates()!.date}` : "Couldn't fetch rates — check your connection."}
        </div>
      </Show>
    </div>
  );
};

export default Converter;
