/** Mock of @tauri-apps/api/event for the UI preview. No backend emits events,
 *  but the page can fire one by hand through `window.__fluxPreviewEmit` — that
 *  is how the preview measures what a tab title or url event costs the chrome. */
export type UnlistenFn = () => void;

type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Set<Handler>>();

export function listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<UnlistenFn> {
  const set = handlers.get(event) ?? new Set<Handler>();
  handlers.set(event, set);
  set.add(cb as Handler);
  return Promise.resolve(() => void set.delete(cb as Handler));
}

(window as unknown as { __fluxPreviewEmit: (event: string, payload: unknown) => void }).__fluxPreviewEmit = (
  event,
  payload,
) => {
  for (const cb of handlers.get(event) ?? []) cb({ payload });
};
