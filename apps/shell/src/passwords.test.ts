/**
 * The password sentinel's decisions on a live page.
 *
 * `crates/flux-core/assets/passwords.js` runs only inside a real tab, so this
 * runs it against a small fake DOM: inputs and forms with the properties the
 * script reads, the chip elements it creates, a fake clock for its debounce,
 * and a recorded `invoke` with canned vault answers. It checks what the
 * script asks Rust for and which chip it shows, not how anything renders.
 */
import { describe, expect, it } from "vitest";

import src from "../../../crates/flux-core/assets/passwords.js?raw";

type Listener = (e: { target?: unknown; stopPropagation?: () => void }) => void;

class Target {
  private listeners = new Map<string, Listener[]>();
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string, target?: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ target, stopPropagation: () => {} });
  }
}

class Input extends Target {
  readonly tagName = "INPUT";
  value = "";
  disabled = false;
  readOnly = false;
  form: Form | null = null;
  constructor(
    public type = "text",
    public name = "",
    public autocomplete = "",
    public id = "",
  ) {
    super();
  }
  getBoundingClientRect() {
    return { top: 100, bottom: 132, left: 10, width: 220, height: 32 };
  }
  closest(): Form | null {
    return this.form;
  }
  matches(sel: string): boolean {
    return sel === 'input[type="password"]' && this.type === "password";
  }
  dispatchEvent(): boolean {
    return true;
  }
}

class Form extends Target {
  readonly tagName = "FORM";
  action = "";
  id = "";
  className = "";
  constructor(
    public inputs: Input[],
    public textContent = "",
  ) {
    super();
    for (const i of inputs) i.form = this;
  }
  querySelectorAll(sel: string): Input[] {
    if (sel === 'input[type="password"]') return this.inputs.filter((i) => i.type === "password");
    return sel === "input" ? this.inputs : [];
  }
  querySelector(): null {
    return null;
  }
}

/** What the script builds for its chip: a div holding a label span and a ✕. */
class El extends Target {
  id = "";
  textContent = "";
  style: Record<string, string> = {};
  children: El[] = [];
  removed = false;
  appendChild(c: El): El {
    this.children.push(c);
    return c;
  }
  remove(): void {
    this.removed = true;
  }
}

interface Page {
  /** Every vault command the script invoked, in order, by name. */
  calls(cmd: string): unknown[];
  /** Let the debounced scan and any vault answers land (`ms` of fake time). */
  settle(ms?: number): Promise<void>;
  /** The visible chip's label, or null. */
  chip(): string | null;
  clickChip(): Promise<void>;
  /** A DOM change the script's MutationObserver sees. */
  mutate(): void;
  /** One tick of the script's safety-net scan interval. */
  tick(): void;
  focus(el: Input): void;
  submit(form: Form): void;
}

/** Load passwords.js into a page holding `forms`, answering vault calls from `answers`. */
function load(forms: Form[], answers: Record<string, unknown>, title = "Sign in"): Page {
  const inputs = forms.flatMap((f) => f.inputs);
  const calls: { cmd: string; args: unknown }[] = [];
  let clock = 0;
  let nextTimer = 1;
  const timers = new Map<number, { due: number; fn: () => void }>();
  let interval: (() => void) | null = null;
  let observer: (() => void) | null = null;
  const win = new Target();
  const docTarget = new Target();
  const root = new El();

  const document = {
    readyState: "complete",
    title,
    documentElement: root,
    querySelectorAll: (sel: string) =>
      sel === 'input[type="password"]'
        ? inputs.filter((i) => i.type === "password")
        : sel === "input"
          ? inputs
          : [],
    querySelector: () => null,
    addEventListener: (type: string, fn: Listener) => docTarget.addEventListener(type, fn),
    contains: (el: El | Input) => !(el instanceof El && el.removed),
    createElement: () => new El(),
  };
  const invoke = (cmd: string, args: unknown) => {
    const name = cmd.replace("plugin:fluxtab|", "");
    calls.push({ cmd: name, args });
    return Promise.resolve(answers[name]);
  };
  const window: Record<string, unknown> = {
    __TAURI_INTERNALS__: { invoke },
    HTMLInputElement: { prototype: {} },
  };
  window.top = window;

  new Function(
    "window",
    "document",
    "addEventListener",
    "innerHeight",
    "innerWidth",
    "location",
    "setInterval",
    "clearInterval",
    "setTimeout",
    "clearTimeout",
    "MutationObserver",
    src,
  )(
    window,
    document,
    (type: string, fn: Listener) => win.addEventListener(type, fn),
    800,
    1280,
    { pathname: "/login" },
    (fn: () => void) => ((interval = fn), 1),
    () => (interval = null),
    (fn: () => void, ms = 0) => {
      const id = nextTimer++;
      timers.set(id, { due: clock + ms, fn });
      return id;
    },
    (id: number) => timers.delete(id),
    class {
      constructor(cb: () => void) {
        observer = cb;
      }
      observe() {}
    },
  );

  const chipEl = () => [...root.children].reverse().find((c) => !c.removed) ?? null;
  const page: Page = {
    calls: (cmd) => calls.filter((c) => c.cmd === cmd).map((c) => c.args),
    async settle(ms = 1000) {
      const until = clock + ms;
      for (;;) {
        // Drain the script's promise callbacks before advancing the clock.
        await new Promise((r) => setTimeout(r, 0));
        const due = [...timers.entries()]
          .filter(([, t]) => t.due <= until)
          .sort(([, a], [, b]) => a.due - b.due)[0];
        if (!due) break;
        timers.delete(due[0]);
        clock = due[1].due;
        due[1].fn();
      }
      clock = until;
    },
    chip: () => chipEl()?.children[0]?.textContent ?? null,
    async clickChip() {
      chipEl()?.children[0]?.fire("click");
      await page.settle(0);
    },
    mutate: () => observer?.(),
    tick: () => interval?.(),
    focus(el) {
      win.fire("focusin", el);
      docTarget.fire("focusin", el);
    },
    submit(form) {
      // Capture order: the window's listener first, then the form's own.
      win.fire("submit", form);
      form.fire("submit", form);
    },
  };
  return page;
}

describe("passwords.js: sign-up wording", () => {
  const loginForm = () =>
    new Form(
      [new Input("email", "email"), new Input("password", "password")],
      "Email Password Sign in New here? Sign up",
    );

  it("a login form that mentions signing up still offers the saved login", async () => {
    const page = load([loginForm()], { vault_page_info: { unlocked: true, count: 1 } }, "Example – log in or sign up");
    await page.settle();
    expect(page.chip()).toContain("Fill saved login");
    expect(page.calls("vault_page_info")).toHaveLength(1);
  });

  it("with nothing saved for the host, the same form is treated as a sign-up", async () => {
    const page = load([loginForm()], { vault_page_info: { unlocked: true, count: 0 } }, "Example – log in or sign up");
    await page.settle();
    expect(page.chip()).toContain("Use a strong password");
  });

  it("markup that says sign-up skips the vault probe", async () => {
    const form = new Form([new Input("email", "email"), new Input("password", "pw", "new-password")]);
    const page = load([form], { vault_page_info: { unlocked: true, count: 1 } });
    await page.settle();
    expect(page.chip()).toContain("Use a strong password");
    expect(page.calls("vault_page_info")).toHaveLength(0);
  });
});
