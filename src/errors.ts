import type { Err } from "./result.js";
import { err } from "./result.js";
import { Tagged } from "./tagged.js";
import { TaggedError, UnhandledException } from "better-result";

export { TaggedError, UnhandledException };

/**
 * Built-in typed error emitted when an operation exceeds a timeout budget.
 */
export class TimeoutError extends TaggedError("TimeoutError")<{
  message: string;
  timeoutMs: number;
}>() {
  constructor({ timeoutMs }: { timeoutMs: number }) {
    super({ message: `Operation timed out after ${timeoutMs}ms`, timeoutMs });
  }
}

/**
 * Internal control-flow sentinel used to mark logically impossible paths.
 */
export class UnreachableError extends TaggedError("UnreachableError")<{ message: string }>() {
  constructor() {
    super({ message: "Unreachable code path" });
  }
}

/**
 * A typed aggregate error used by combinators that need to preserve multiple failures.
 */
export class ErrorGroup<E> extends Tagged(AggregateError, "ErrorGroup") {
  override readonly errors: E[];
  constructor(errors: Iterable<E>, message: string) {
    super(errors, message);
    this.errors = Array.from(errors);
    this.name = this._tag;
  }

  *[Symbol.iterator](): Generator<Err<never, this>, never, unknown> {
    yield err(this);
    throw new UnreachableError();
  }
}
