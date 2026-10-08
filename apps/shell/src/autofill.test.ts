/**
 * Which fields of a live page get the saved login.
 *
 * `crates/flux-core/assets/autofill.js` runs only inside a real tab, so this
 * drives its `__fluxFill` against a minimal fake DOM: just what the field
 * choice reads (type, name, id, autocomplete, and whether the field has a
 * layout box). Two ways it went wrong: a hidden password input earlier in the
 * page took the password while the visible form stayed empty, and on a
 * two-step sign-in the username went into the first text box on the page
 * (usually the site search) instead of the login field the chip sits on.
 */
import { describe, expect, it } from "vitest";

import src from "../../../crates/flux-core/assets/autofill.js?raw";

interface Field {
  tagName: "INPUT";
  type: string;
  name: string;
  id: string;
  autocomplete: string;
  disabled: boolean;
  readOnly: boolean;
  value: string;
  shadowRoot: null;
  getBoundingClientRect(): { width: number; height: number };
  focus(): void;
  dispatchEvent(): boolean;
}

type Attrs = Partial<Pick<Field, "type" | "name" | "id" | "autocomplete">> & { hidden?: boolean };

const field = (attrs: Attrs): Field => {
  // display:none (or a collapsed container) leaves an input with no box.
  const box = attrs.hidden ? { width: 0, height: 0 } : { width: 220, height: 32 };
  return {
    tagName: "INPUT",
    type: attrs.type ?? "text",
    name: attrs.name ?? "",
    id: attrs.id ?? "",
    autocomplete: attrs.autocomplete ?? "",
    disabled: false,
    readOnly: false,
    value: "",
    shadowRoot: null,
    getBoundingClientRect: () => box,
    focus: () => {},
    dispatchEvent: () => true,
  };
};

/** `__fluxFill("ada", "s3cret")` on a page whose inputs are `fields`, in DOM order. */
const fill = (fields: Field[]): string => {
  const document = { querySelectorAll: (sel: string) => (sel === "*" ? fields : []) };
  const window = { HTMLInputElement: { prototype: {} }, HTMLTextAreaElement: { prototype: {} } };
  const fluxFill = new Function("document", "window", `${src}\nreturn __fluxFill;`)(
    document,
    window,
  ) as (u: string, p: string) => string;
  return fluxFill("ada", "s3cret");
};

describe("autofill field choice", () => {
  it("fills the visible password form, not a hidden login earlier in the page", () => {
    const dropdownUser = field({ type: "email", name: "email", hidden: true });
    const dropdownPw = field({ type: "password", name: "pw", hidden: true });
    const search = field({ name: "q" });
    const user = field({ name: "username" });
    const pw = field({ type: "password", name: "password" });

    expect(fill([dropdownUser, dropdownPw, search, user, pw])).toBe("both");
    expect(pw.value).toBe("s3cret");
    expect(user.value).toBe("ada");
    expect(dropdownPw.value).toBe("");
    expect(search.value).toBe("");
  });

  it("two-step sign-in: the username goes to the login field, not the site search", () => {
    const search = field({ name: "q" });
    const user = field({ name: "username" });

    expect(fill([search, user])).toBe("username");
    expect(user.value).toBe("ada");
    expect(search.value).toBe("");
  });

  it("two-step sign-in with a hidden password input: fills only the username", () => {
    // Google's identifier step keeps a hidden password input in the page.
    const hiddenPw = field({ type: "password", name: "hiddenPassword", hidden: true });
    const user = field({ type: "email", id: "identifierId", autocomplete: "username webauthn" });

    expect(fill([hiddenPw, user])).toBe("username");
    expect(user.value).toBe("ada");
    expect(hiddenPw.value).toBe("");
  });

  it("fills nothing on a page with no password and no login field", () => {
    const search = field({ name: "q" });

    expect(fill([search])).toBe("none");
    expect(search.value).toBe("");
  });

  it("beside a password, the nearest preceding text box is still the username", () => {
    const search = field({ name: "q" });
    const ident = field({ name: "ident" });
    const pw = field({ type: "password", name: "secret" });

    expect(fill([search, ident, pw])).toBe("both");
    expect(ident.value).toBe("ada");
    expect(search.value).toBe("");
  });
});
