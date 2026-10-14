import { describe, expect, it } from "vitest";

import { dialogsOpen, holdDialog } from "./dialogs";

describe("holdDialog", () => {
  it("counts each open dialog until it is released", () => {
    const a = holdDialog();
    const b = holdDialog();
    expect(dialogsOpen()).toBe(2);
    a();
    expect(dialogsOpen()).toBe(1);
    b();
    expect(dialogsOpen()).toBe(0);
  });

  it("ignores a second release, so a dialog closed twice can't free another's hold", () => {
    const a = holdDialog();
    const b = holdDialog();
    a();
    a();
    expect(dialogsOpen()).toBe(1);
    b();
    expect(dialogsOpen()).toBe(0);
  });
});
