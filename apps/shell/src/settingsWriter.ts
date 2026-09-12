import { createSignal } from "solid-js";

/** Serialize writes; only show the new value after the backend acknowledges it. */
export function settingsWriter() {
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal("");
  let retryAction: (() => Promise<void>) | undefined;
  const run = async (label: string, save: () => Promise<unknown>, commit: () => void = () => {}) => {
    if (pending()) return;
    setPending(true);
    setError("");
    retryAction = () => run(label, save, commit);
    try {
      await save();
      commit();
      retryAction = undefined;
    } catch {
      // Backend messages can contain paths or credentials; keep the UI concise.
      setError(`Could not save ${label}. Please try again.`);
    } finally {
      setPending(false);
    }
  };
  return { pending, error, run, retry: () => retryAction?.() };
}
