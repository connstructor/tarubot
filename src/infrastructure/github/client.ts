/** Public GitHub history with bounded requests, shared caching, and verified-signature metadata. */
import { z } from "zod";
import { project } from "../../config/project.js";

export const DEFAULT_COMMIT_COUNT = 5;
export const MAX_COMMIT_COUNT = 10;
const countSchema = z.number().int().min(1).max(MAX_COMMIT_COUNT);
const commitsSchema = z
  .array(
    z.object({
      sha: z.string().regex(/^[0-9a-f]{40}$/),
      commit: z.object({
        message: z.string(),
        verification: z
          .object({
            verified: z.boolean(),
            reason: z.string(),
            signature: z.string().nullable().optional(),
          })
          .optional(),
      }),
    }),
  )
  .max(MAX_COMMIT_COUNT);

export interface GitHubCommit {
  readonly sha: string;
  readonly title: string;
  readonly url: string;
  readonly verified: boolean;
}
export interface CommitHistory {
  readonly commits: readonly GitHubCommit[];
  readonly checkedAt: string;
  readonly warning: string | null;
}
/** A small fetch boundary supports controlled response/transport tests without live credentials. */
type Request = (url: string, init: RequestInit) => Promise<Response>;

export class GitHubHistory {
  private cached: { until: number; history: CommitHistory } | undefined;
  private pending: Promise<CommitHistory> | undefined;

  constructor(
    private readonly request: Request = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Fetch one maximal page for all requested counts; concurrent callers share the same request. */
  async recent(count = DEFAULT_COMMIT_COUNT): Promise<CommitHistory> {
    countSchema.parse(count);
    let history = this.cached && this.cached.until > this.now() ? this.cached.history : undefined;
    if (!history) {
      this.pending ??= this.acquire().finally(() => {
        this.pending = undefined;
      });
      history = await this.pending;
    }
    return { ...history, commits: history.commits.slice(0, count) };
  }

  /** Cache successful history for five minutes, and failures briefly to avoid retry storms. */
  private async acquire(): Promise<CommitHistory> {
    let commits: GitHubCommit[] = [];
    let warning: string | null = null;
    try {
      const response = await this.request(
        `https://api.github.com/repos/${project.repository}/commits?sha=${project.branch}&per_page=${MAX_COMMIT_COUNT}`,
        {
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": `TaruBot/${project.version}`,
          },
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!response.ok) {
        warning =
          response.status === 429 ||
          (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")
            ? "GitHub is rate-limiting commit history. Please try again later."
            : "GitHub commit history is temporarily unavailable. Please try again shortly.";
      } else {
        commits = commitsSchema.parse(await response.json()).map(({ sha, commit }) => ({
          sha,
          title: commit.message.split(/\r?\n/)[0]?.trim() || "Untitled commit",
          // Construct links from validated IDs, rather than trusting arbitrary URLs in the response.
          url: `${project.url}/commit/${sha}`,
          verified:
            commit.verification?.verified === true &&
            commit.verification.reason === "valid" &&
            Boolean(commit.verification.signature),
        }));
      }
    } catch {
      // The installed version remains available during transport, timeout, or response-shape failures.
      warning = "GitHub commit history is temporarily unavailable. Please try again shortly.";
    }
    const history = { commits, checkedAt: new Date(this.now()).toISOString(), warning };
    this.cached = { until: this.now() + (warning ? 60000 : 300000), history };
    return history;
  }
}
