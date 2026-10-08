import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type Mod = typeof import("./Calculator");
let evaluate: Mod["evaluate"];
let fmtResult: Mod["fmtResult"];

beforeAll(async () => {
  // A component module: importing it registers Solid's delegated event
  // handlers on `window.document`, which a node test doesn't have.
  vi.stubGlobal("window", { document: { addEventListener: () => {} } });
  ({ evaluate, fmtResult } = await import("./Calculator"));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const calc = (src: string) => evaluate(src, true, 0);

describe("calculator exponent notation", () => {
  it("can keep calculating with a result it showed in exponent form", () => {
    // `=` writes the formatted result back into the expression, and for very
    // large or small numbers that is a signed exponent ("1.099512e+12").
    const big = fmtResult(calc("2^40"));
    expect(big).toBe("1.099512e+12");
    expect(calc(`${big}+1`)).toBe(1099512000001);

    const small = fmtResult(calc("3/10000000"));
    expect(small).toBe("3e-7");
    expect(calc(`${small}*2`)).toBeCloseTo(6e-7, 20);
  });

  it("reads the plain and signed exponent forms", () => {
    expect(calc("1e3")).toBe(1000);
    expect(calc("1.5e+12")).toBe(1.5e12);
    expect(calc("1e-7*2")).toBeCloseTo(2e-7, 20);
  });

  it("still treats a bare e as the constant", () => {
    expect(calc("e")).toBe(Math.E);
    expect(calc("e+1")).toBe(Math.E + 1);
    expect(calc("2*e")).toBe(2 * Math.E);
    // No implicit multiplication: "2e" was, and stays, an error.
    expect(() => calc("2e")).toThrow();
  });
});
