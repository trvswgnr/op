import type { ExitContext, Instruction } from "./types.js";
import { Tagged } from "../tagged.js";

type SuspendFn = (signal: AbortSignal) => Promise<unknown>;
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

  constructor(finalize: FinalizeFn) {
    super();
    this.finalize = finalize;
  }
}
