import { basename } from "node:path";
const consoleLogger = console;

export const color = {
  cyan: (text: string) => `\x1b[36m${text}\x1b[0m`,
  yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
  red: (text: string) => `\x1b[31m${text}\x1b[0m`,
};

/**
 * Creates a logger with a prefix based on the file name
 * @param path The path to the file
 * @returns A logger with a prefix based on the file name
 * @example
 * const logger = createLogger(import.meta.url);
 * logger.info("Hello, world!");
 */
export const createLogger = (path: string) => {
  const name = basename(path, ".ts");
  return {
    info: (...args: unknown[]) =>
      consoleLogger.info(`|${name}| ${color.cyan(`[INFO]`.padEnd(7))}`, ...args),
    warn: (...args: unknown[]) =>
      consoleLogger.warn(`|${name}| ${color.yellow(`[WARN]`.padEnd(7))}`, ...args),
    error: (...args: unknown[]) =>
      consoleLogger.error(`|${name}| ${color.red(`[ERROR]`.padEnd(7))}`, ...args),
  } as const;
};
