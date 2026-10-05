// Shared unit-test helpers.

/** A promise with its `resolve` and `reject` exposed. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets pending promise callbacks and timers at 0 ms run. */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
