/**
 * The private reports repository's issues (2.18.0): create an issue, comment on one, and read its
 * state. The token is a fine-grained token limited to that repository's issues. Failures map to
 * catalog codes so the job queue treats them correctly: GitHub's rate limits and outages wait or
 * retry, and a refused token is a configuration failure an operator must fix. Since 2.26.0
 * /suggest also creates issues through it, in the public repository with a GitHub App
 * installation token (src/infrastructure/github/app.ts), naming its own settings when refused.
 */
import { z } from "zod";
import { project } from "../../config/project.js";
import { Failure } from "../../domain/values.js";

/** A small fetch boundary, so contract tests run against a local fake without credentials. */
export type Request = (url: string, init: RequestInit) => Promise<Response>;

const issueSchema = z.object({ number: z.number().int().positive(), state: z.string() });

export interface IssueRef {
  readonly number: number;
  readonly state: "open" | "closed";
}

/**
 * How long GitHub asks TaruBot to wait, in seconds, when a refused answer is a rate limit, or null
 * when it isn't one. Shared by the issue client and, since 2.26.0, the GitHub App's sign-in
 * (src/infrastructure/github/app.ts). It consumes the body: a 403's text is read to classify it,
 * and any other body is released.
 */
export async function rateLimitWait(response: Response): Promise<number | null> {
  // GitHub's own words can echo the request, so they only classify a 403 and never reach
  // diagnostics: a secondary rate limit can arrive as a 403 with no rate-limit headers, and only
  // its message ("You have exceeded a secondary rate limit") tells it from a refused token.
  const secondary =
    response.status === 403 && /rate limit/iu.test((await response.text()).slice(0, 4096));
  if (response.status !== 403) await response.body?.cancel();
  const retry = Number(response.headers.get("retry-after"));
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const exhausted = response.headers.get("x-ratelimit-remaining") === "0";
  // Primary and secondary rate limits arrive as 429, or as 403 with rate-limit headers or a
  // rate-limit message; with neither header, GitHub asks for at least a minute's wait.
  if (
    response.status !== 429 &&
    !(response.status === 403 && (exhausted || retry > 0 || secondary))
  )
    return null;
  return Number.isFinite(retry) && retry > 0
    ? retry
    : exhausted && Number.isFinite(reset)
      ? Math.max(1, reset - Math.floor(Date.now() / 1000))
      : 60;
}

export class GitHubIssues {
  constructor(
    private readonly token: string,
    private readonly repository: string,
    private readonly request: Request = fetch,
    private readonly api = "https://api.github.com",
    /** The settings a refusal tells the operator to check; /suggest names the GitHub App's. */
    private readonly settings = "GITHUB_REPORTS_TOKEN and GITHUB_REPORTS_REPO",
  ) {}

  /** Open an issue; labels GitHub doesn't know yet are created with it. */
  async create(title: string, body: string, labels: readonly string[]): Promise<IssueRef> {
    return this.issue(
      await this.call("POST", `/repos/${this.repository}/issues`, { title, body, labels }),
    );
  }

  /** Add a comment to an existing issue. */
  async comment(number: number, body: string): Promise<void> {
    await this.call("POST", `/repos/${this.repository}/issues/${number}/comments`, { body });
  }

  /** Read an issue's state, so a repeat of a closed issue can open a new one. */
  async get(number: number): Promise<IssueRef> {
    return this.issue(await this.call("GET", `/repos/${this.repository}/issues/${number}`));
  }

  private issue(raw: unknown): IssueRef {
    const parsed = issueSchema.safeParse(raw);
    if (!parsed.success)
      throw new Failure("invalid_response", "GitHub returned an issue without a number or state.");
    return {
      number: parsed.data.number,
      state: parsed.data.state === "closed" ? "closed" : "open",
    };
  }

  /** One bounded API call; the response body is read only when it is JSON the caller needs. */
  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(`${this.api}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "user-agent": `TaruBot/${project.version}`,
          "x-github-api-version": "2022-11-28",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Failure("unavailable", "GitHub didn't answer the issue report in time.");
    }
    if (response.ok) return response.status === 204 ? null : response.json();
    const wait = await rateLimitWait(response);
    if (wait !== null)
      throw new Failure("rate_limited", "GitHub is rate limiting issue reports.", wait);
    if (response.status >= 500)
      throw new Failure("unavailable", `GitHub answered ${response.status}.`, 60);
    if ([401, 403, 404, 410].includes(response.status))
      throw new Failure(
        "configuration",
        `GitHub refused the issue report (${response.status}); check ${this.settings}.`,
      );
    throw new Failure("invalid_data", `GitHub rejected the issue report (${response.status}).`);
  }
}
