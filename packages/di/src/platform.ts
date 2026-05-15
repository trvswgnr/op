export interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(
    type: "abort",
    listener: (event: unknown) => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: (event: unknown) => void): void;
}
