/** Debounce a query and discard work superseded by typing, clearing or unmounting. */
export function latestQuery<T>(
  run: (query: string) => Promise<T>,
  receive: (result: T) => void,
  fail: (error: unknown) => void,
  delay = 120,
) {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    generation++;
    clearTimeout(timer);
  };
  return {
    cancel,
    search(query: string) {
      cancel();
      if (!query.trim()) return;
      const current = generation;
      timer = setTimeout(async () => {
        try {
          const result = await run(query);
          if (current === generation) receive(result);
        } catch (error) {
          if (current === generation) fail(error);
        }
      }, delay);
    },
  };
}
