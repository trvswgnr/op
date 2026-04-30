declare global {
  interface AddEventListenerOptions {
    once?: boolean;
  }

  interface AbortSignal {
    readonly aborted: boolean;
    readonly reason: unknown;
    addEventListener(
      type: "abort",
      listener: (this: AbortSignal) => void,
      options?: AddEventListenerOptions,
    ): void;
    removeEventListener(type: "abort", listener: (this: AbortSignal) => void): void;
  }

  var AbortSignal: {
    prototype: AbortSignal;
  };

  interface AbortController {
    readonly signal: AbortSignal;
    abort(reason?: unknown): void;
  }

  var AbortController: {
    new (): AbortController;
    prototype: AbortController;
  };

  class DOMException extends Error {
    constructor(message?: string, name?: string);
  }

  function setTimeout(
    callback: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ): number;
  function clearTimeout(id: ReturnType<typeof setTimeout> | undefined): void;
}

export {};
