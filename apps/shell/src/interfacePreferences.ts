import { createSignal } from "solid-js";
export type Density = "compact" | "comfortable";
const readDensity = (): Density => {
  try {
    return localStorage.getItem("flux.interface.density") === "comfortable" ? "comfortable" : "compact";
  } catch {
    return "compact";
  }
};
export const [density, setDensityRaw] = createSignal<Density>(readDensity());
if (typeof document !== "undefined") document.documentElement.dataset.density = density();
export function setDensity(value: Density): void {
  localStorage.setItem("flux.interface.density", value);
  setDensityRaw(value);
  document.documentElement.dataset.density = value;
}
