// Answers memoised by key. A request already on its way is shared, a failure
// is not kept, and clear() also stops a request in flight from storing its
// pre-clear answer.
export interface PromiseCache<T> {
  get(key: string, load: () => Promise<T>): Promise<T>;
  // The stored answer, for callers that render it without a loading state.
  peek(key: string): T | undefined;
  clear(): void;
}

export function createPromiseCache<T>(): PromiseCache<T> {
  const done = new Map<string, T>();
  const inflight = new Map<string, Promise<T>>();
  return {
    get(key, load) {
      if (done.has(key)) return Promise.resolve(done.get(key) as T);
      const pending = inflight.get(key);
      if (pending) return pending;
      const request = load()
        .then((value) => {
          if (inflight.get(key) === request) done.set(key, value);
          return value;
        })
        .finally(() => {
          if (inflight.get(key) === request) inflight.delete(key);
        });
      inflight.set(key, request);
      return request;
    },
    peek: (key) => done.get(key),
    clear() {
      done.clear();
      inflight.clear();
    },
  };
}
