/**
 * The last log records, kept in memory for issue reports (2.18.0). The composition root adds this as
 * a second pino destination at info and above, so it holds exactly what the container log shows,
 * after pino's own redaction. A report includes the newest records, redacted again, as context for
 * what the bot was doing just before the trouble.
 */
export class RecentLogs {
  private readonly lines: string[] = [];

  constructor(private readonly capacity = 60) {}

  /** pino's destination interface: one serialized JSON record per call. */
  write(line: string): void {
    this.lines.push(line.trimEnd());
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
  }

  /** The newest `count` records, oldest first. */
  recent(count = 30): string[] {
    return this.lines.slice(-count);
  }
}
