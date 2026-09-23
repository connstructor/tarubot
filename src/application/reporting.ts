/**
 * Structured failure reports for interactions, gateway events, the lifecycle and the queue worker.
 * Extracted from the composition root so the level and field rules can be unit-tested.
 */
import { classifyFailure, type ReportLevel, type ReportOptions } from "../domain/failures.js";

/** The pino methods a reporter calls. A narrow shape lets tests supply a recording fake. */
export type ReportLog = {
  readonly [Level in ReportLevel]: (fields: Readonly<Record<string, unknown>>, msg: string) => void;
};

/** Report one caught error under an operation ID (an interaction ID, job ID or named task). */
export type Reporter = (error: unknown, operation: string, options?: ReportOptions) => void;

/**
 * One fixed message per level, so a log search can separate approved refusals (info) from
 * dependency or settings trouble (warn) and failures that need investigation (error).
 */
const MESSAGE = {
  info: "Interaction refused with an approved reason.",
  warn: "Operation could not complete; a dependency or setting needs attention.",
  error: "Operation failed; inspect scoped work status.",
} as const satisfies Record<ReportLevel, string>;

/**
 * Create the reporter. It logs the operation, catalog code, category, error class (`source`) and
 * interaction scope at the level passed in, defaulting to error. Error objects may carry transport
 * credentials, page bodies or SDK text, so only an approved Failure message is logged, as
 * `diagnostic`; any other error contributes its class name alone.
 */
export function createReporter(log: ReportLog): Reporter {
  return (error, operation, options = {}) => {
    const level = options.level ?? "error";
    const { code, category, source, failure } = classifyFailure(error);
    log[level](
      {
        operation,
        code,
        category,
        source,
        scope: options.scope,
        diagnostic: failure?.message,
      },
      MESSAGE[level],
    );
  };
}
