/**
 * The TaruBot GitHub App's sign-in (2.26.0, issue #32): /suggest opens public issues as the app's
 * bot account, never as the owner's. The app (App ID 5076273) has Issues write and Metadata read
 * only, no webhook, and is installed on this repository alone.
 *
 * Every post mints a fresh installation token, never cached: the bot signs a short RS256 JWT with
 * the app's private key, finds the app's installation on the repository, and asks for a token
 * narrowed to that one repository and to Issues write. Tokens last an hour and nothing is stored,
 * so there is nothing to refresh; the key itself has no expiry and is rotated on the app's page.
 *
 * Failures map to catalog codes. No message ever carries the key, the JWT or the token, and
 * GitHub's own response text only tells a rate limit from a refusal; it is never read into one.
 */
import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { z } from "zod";
import { project } from "../../config/project.js";
import { Failure } from "../../domain/values.js";
import { rateLimitWait, type Request } from "./issues.js";

/** `GET /repos/{repository}/installation`: the app's installation on that repository. */
const installationSchema = z.object({ id: z.number().int().positive() });
/** `POST /app/installations/{id}/access_tokens`: the one-hour installation token. */
const tokenSchema = z.object({ token: z.string().min(1) });

/** The JWT's lifetime: backdated a minute for clock drift, and within GitHub's 10-minute cap. */
const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 540;

/** base64url of a JSON value, for the JWT's header and claims. */
const encoded = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

export class GitHubApp {
  constructor(
    /** The app's client ID, which GitHub accepts as the JWT issuer. Not a secret. */
    private readonly clientId: string,
    /** The app's private key (PEM; GitHub downloads PKCS#1). */
    private readonly privateKey: string,
    /** `owner/name` the app is installed on; the token is narrowed to it. */
    private readonly repository: string,
    private readonly request: Request = fetch,
    private readonly api = "https://api.github.com",
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** A fresh installation token for the repository's issues. Two GitHub calls; never cached. */
  async installationToken(): Promise<string> {
    const jwt = this.jwt();
    const installation = await this.call(
      "GET",
      `/repos/${this.repository}/installation`,
      jwt,
      installationSchema,
    );
    const minted = await this.call(
      "POST",
      `/app/installations/${installation.id}/access_tokens`,
      jwt,
      tokenSchema,
      {
        repositories: [this.repository.split("/")[1] ?? this.repository],
        permissions: { issues: "write" },
      },
    );
    return minted.token;
  }

  /**
   * The app's JWT: RS256 over `{iat, exp, iss}`. A key that won't parse, or isn't RSA, is a
   * configuration failure naming the setting. A value pasted on one line with literal `\n`
   * escapes is accepted too: a PEM never contains a backslash.
   */
  jwt(): string {
    let key: KeyObject;
    try {
      key = createPrivateKey(this.privateKey.replaceAll("\\n", "\n"));
    } catch {
      throw new Failure("configuration", "GITHUB_APP_PRIVATE_KEY isn't a readable private key.");
    }
    if (key.asymmetricKeyType !== "rsa")
      throw new Failure("configuration", "GITHUB_APP_PRIVATE_KEY isn't an RSA private key.");
    const seconds = Math.floor(this.now() / 1000);
    const unsigned = `${encoded({ alg: "RS256", typ: "JWT" })}.${encoded({
      iat: seconds - JWT_BACKDATE_SECONDS,
      exp: seconds + JWT_LIFETIME_SECONDS,
      iss: this.clientId,
    })}`;
    return `${unsigned}.${sign("sha256", Buffer.from(unsigned), key).toString("base64url")}`;
  }

  /**
   * One bounded call. A 2xx body is read inside the same try as its parse, so a timeout while
   * reading it, malformed JSON or an unexpected shape is `invalid_response`, never a plain error.
   */
  private async call<T>(
    method: "GET" | "POST",
    path: string,
    jwt: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.request(`${this.api}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
          "user-agent": `TaruBot/${project.version}`,
          "x-github-api-version": "2022-11-28",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Failure("unavailable", "GitHub didn't answer TaruBot's app sign-in.", 60);
    }
    if (response.ok) {
      try {
        const parsed = schema.safeParse(await response.json());
        if (parsed.success) return parsed.data;
      } catch {
        // Unreadable: reported below with the same message as a wrong shape.
      }
      throw new Failure("invalid_response", "GitHub's app sign-in answer was unreadable.");
    }
    // GitHub's rate limits (a 429, or a 403 that says so) are classified as the issue client
    // classifies them, so /suggest reads them as a wait and records nothing. A body that can't be
    // read is no rate limit, and the status below decides.
    const wait = await rateLimitWait(response).catch(() => null);
    if (wait !== null)
      throw new Failure("rate_limited", "GitHub is rate limiting TaruBot's app sign-in.", wait);
    // A refused JWT, a missing installation or a refused token request needs the operator.
    if ([401, 403, 404, 422].includes(response.status))
      throw new Failure(
        "configuration",
        `GitHub refused TaruBot's GitHub App (${response.status}); check GITHUB_APP_CLIENT_ID, GITHUB_APP_PRIVATE_KEY and the app's installation on ${this.repository}.`,
      );
    // Outages and anything unexpected: nothing was posted, try later.
    throw new Failure(
      "unavailable",
      `GitHub answered TaruBot's app sign-in with ${response.status}.`,
      60,
    );
  }
}
