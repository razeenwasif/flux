/** Mock of @tauri-apps/api/event for the UI preview. Events never fire. */
export type UnlistenFn = () => void;

export function listen<T>(_event: string, _cb: (e: { payload: T }) => void): Promise<UnlistenFn> {
  return Promise.resolve(() => {});
}
