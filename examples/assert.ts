export class AssertionError extends Error {
  name = "AssertionError";
}

export type Assert = (condition: unknown, message: string) => asserts condition;

export const assert: Assert = (condition, message) => {
  if (!condition) throw new AssertionError(message);
};
