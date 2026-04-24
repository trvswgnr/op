import type { Typed } from "./typed.js";

export interface Ok<T> extends Typed<"Ok"> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> extends Typed<"Err"> {
  readonly ok: false;
  readonly error: E;
}

/**
 * Discriminated result of operation execution.
 *
 * When `ok` is `true`, read `value`. When `ok` is `false`, read `error`.
 */
export type Result<T, E> = Ok<T> | Err<E>;

export type ExtractErr<Y> = Y extends Err<infer U> ? U : never;

export const ok = <T>(value: T): Ok<T> => Object.freeze({ type: "Ok", ok: true, value });
export const err = <E>(error: E): Err<E> => Object.freeze({ type: "Err", ok: false, error });
