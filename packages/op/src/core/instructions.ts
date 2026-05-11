import type { ExitContext, Instruction, RunContext } from "./types.js";
import { Tagged } from "../tagged.js";
import { Err } from "../result.js";

type SuspendFn = (ctx: RunContext<readonly unknown[]>) => Promise<unknown>;
export class SuspendInstruction extends Tagged("SuspendInstruction") {
  readonly suspend: SuspendFn;

  constructor(suspend: SuspendFn) {
    super();
    this.suspend = suspend;
  }

  // SAFETY: TS doesn't know the type of the yielded value, so it's always `unknown`
  // we use a single `any` here to avoid casting at every call site
  // oxlint-disable-next-line typescript/no-explicit-any
  *[Symbol.iterator](): Generator<Instruction<never>, any, unknown> {
    return (yield this) as never;
  }
}

type FinalizeFn = (ctx: ExitContext<unknown, unknown, readonly unknown[]>) => Promise<void>;
export class RegisterExitFinalizerInstruction extends Tagged("RegisterExitFinalizerInstruction") {
  readonly finalize: FinalizeFn;
  readonly args: readonly unknown[] | undefined;

  constructor(finalize: FinalizeFn, args?: readonly unknown[]) {
    super();
    this.finalize = finalize;
    this.args = args;
  }
}

export function isErrInstruction<E>(value: unknown): value is Err<unknown, E> {
  return (
    typeof value === "object" &&
    value !== null &&
    "isErr" in value &&
    typeof value.isErr === "function" &&
    value.isErr()
  );
}
