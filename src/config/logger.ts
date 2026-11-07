import util from "node:util";
import winston, { Logger } from "winston";
import config from "./config";

// Format to include error stack trace
const enumerateErrorFormat = winston.format((info) => {
  if (info instanceof Error) {
    Object.assign(info, { message: info.stack });
  }
  return info;
});

// Where winston parks every argument after the message. The symbol is the
// documented key for that array, not an internal detail.
const SPLAT = Symbol.for("splat");

// `util.format`'s placeholders. When the message carries one the trailing
// arguments are interpolation operands and belong to `format.splat()` below —
// folding them in here as well would print them twice.
const FORMAT_TOKENS = /%[sdifjoOc%]/;

const stackOf = (error: Error): string =>
  error.stack ?? `${error.name}: ${error.message}`;

// A stack's first line is `Name: message`. Everything after it is frames.
const framesOf = (stack: string): string => {
  const breakAt = stack.indexOf("\n");
  return breakAt === -1 ? "" : stack.slice(breakAt + 1);
};

/**
 * Fold the trailing arguments into the message.
 *
 * `printf` below renders `message` and nothing else. Winston's own `log()`
 * merges `meta.message` into it when the first trailing argument is an Error,
 * so the error's *text* survived — but its stack never did, and nothing else
 * in the chain was going to add it. `format.splat()` cannot: with no `%`
 * token in the message it treats the argument as metadata and merges its
 * *enumerable* keys onto `info`, and an Error has none. `enumerateErrorFormat`
 * cannot either: it fires when the logged value *is* an Error, not when one
 * rides along beside it.
 *
 * `src/index.ts` logs this way on all four of its crash paths, the
 * `uncaughtException` handler included — so a production crash named the
 * error and not one line of where it came from. Plain object metadata was
 * dropped outright, keys and all.
 */
const foldSplatIntoMessage = winston.format((info) => {
  const splat = info[SPLAT];
  if (!Array.isArray(splat) || splat.length === 0) return info;

  const message = typeof info.message === "string" ? info.message : String(info.message);
  if (FORMAT_TOKENS.test(message)) return info;

  const appended: string[] = [];
  for (const value of splat) {
    if (value instanceof Error) {
      const stack = stackOf(value);
      // Winston already put this error's message in `info.message`, so the
      // stack's header line would say it a second time. Keep the frames,
      // which are the part that was actually missing.
      const rendered =
        value.message !== "" && message.includes(value.message)
          ? framesOf(stack)
          : stack;
      if (rendered !== "") appended.push(rendered);
      continue;
    }
    appended.push(util.inspect(value, { depth: 3, breakLength: Infinity }));
  }

  if (appended.length > 0) {
    info.message = [message, ...appended].join("\n");
  }
  // Consumed, so `format.splat()` does not merge the same values back onto
  // `info` as stray metadata keys.
  info[SPLAT] = [];
  return info;
});

// Create the logger
const logger: Logger = winston.createLogger({
  level: config.ENV === "development" ? "debug" : "info",
  format: winston.format.combine(
    enumerateErrorFormat(),
    // Before splat(), which is what would otherwise swallow the extra
    // arguments without rendering them.
    foldSplatIntoMessage(),
    winston.format.timestamp({ format: "YYYY-MM-DD:hh:mm:ss:a" }),
    config.ENV === "development"
      ? winston.format.colorize()
      : winston.format.uncolorize(),
    winston.format.splat(),
    winston.format.printf(({ level, message, timestamp }) => {
      return `[${timestamp}] ${level}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      stderrLevels: ["error"],
    }),
  ],
});

export default logger;
