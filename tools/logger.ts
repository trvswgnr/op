import * as path from "node:path";

const consoleLogger = console;

export const color = {
  cyan: (text: string) => `\x1b[36m${text}\x1b[0m`,
  yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
  red: (text: string) => `\x1b[31m${text}\x1b[0m`,
};

/**
 * Creates a logger with a prefix based on the file name.
 * @param filepath The file path to use for the logger prefix.
 * @returns A logger with a prefix based on the file name.
 * @example
 * const logger = createLogger(import.meta.url);
 * logger.info("Hello, world!");
 */
export function createLogger(filepath?: string) {
  const prefix = filepath ? `|${path.basename(filepath, ".ts")}| ` : "";
  return {
    info: (...args: unknown[]) => consoleLogger.info(`${prefix}${color.cyan("[INFO]")}`, ...args),
    warn: (...args: unknown[]) => consoleLogger.warn(`${prefix}${color.yellow("[WARN]")}`, ...args),
    error: (...args: unknown[]) => consoleLogger.error(`${prefix}${color.red("[ERROR]")}`, ...args),
  } as const;
}
