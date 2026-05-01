import type { ExitContext } from "./types.js";
import { Tagged } from "../tagged.js";

export class SuspendInstruction extends Tagged("SuspendInstruction") {
  readonly suspend: (signal: AbortSignal) => Promise<unknown>;

  constructor(suspend: (signal: AbortSignal) => Promise<unknown>) {
    super();
    this.suspend = suspend;
  }
}

export class RegisterExitFinalizerInstruction extends Tagged("RegisterExitFinalizerInstruction") {
  readonly finalize: (ctx: ExitContext<unknown, unknown>) => Promise<void>;

  constructor(finalize: (ctx: ExitContext<unknown, unknown>) => Promise<void>) {
    super();
    this.finalize = finalize;
  }
}
