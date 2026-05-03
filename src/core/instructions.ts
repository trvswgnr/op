import type { ExitContext } from "./types.js";
import { Tagged } from "../tagged.js";

type SuspendFn = (signal: AbortSignal) => Promise<unknown>;
export class SuspendInstruction extends Tagged("SuspendInstruction") {
  readonly suspend: SuspendFn;

  constructor(suspend: SuspendFn) {
    super();
    this.suspend = suspend;
  }
}

type FinalizeFn = (ctx: ExitContext<unknown, unknown>) => Promise<void>;
export class RegisterExitFinalizerInstruction extends Tagged("RegisterExitFinalizerInstruction") {
  readonly finalize: FinalizeFn;

  constructor(finalize: FinalizeFn) {
    super();
    this.finalize = finalize;
  }
}
