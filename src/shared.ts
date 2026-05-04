/**
 * UNSAFE: casts any value to a given type
 *
 * @warning This function is UNSAFE and should be used only when the type is known to be correct
 * Every call site for this function should be accompanied by a comment explaining why it is
 * absolutely necessary.
 */
export function cast<T>(value: unknown): T {
  return value as T;
}
