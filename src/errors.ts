import type { Err } from "./result.js";
import { Result } from "./result.js";
import { Tagged } from "./tagged.js";
import { TaggedError, UnhandledException, type TaggedErrorInstance } from "better-result";

export { TaggedError, UnhandledException, type TaggedErrorInstance };

/**
 * Built-in typed error emitted when an operation exceeds a timeout budget
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
 * A typed aggregate error used by combinators that need to preserve multiple failures
 */
export class ErrorGroup<E> extends Tagged("ErrorGroup", AggregateError) {
  declare readonly errors: E[];
  constructor(errors: Iterable<E>, message: string) {
    super(errors, message);
    this.name = this._tag;
  }

  *[Symbol.iterator](): Generator<Err<never, this>, never, unknown> {
    return yield* Result.err(this);
  }

  static is(value: unknown): value is ErrorGroup<unknown> {
    return value instanceof ErrorGroup;
  }
}
