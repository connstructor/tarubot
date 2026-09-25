/**
 * An off-host, encrypted copy of the production host's `.env` (2.23.0; the owner's 2026-09-25
 * decision to make the host robust and disposable). Run it on the operator machine after changing
 * the host's settings: it reads `~/tarubot/.env` over SSH and encrypts it with `age` for the public
 * keys in `ops/age-recipients.txt`. Only the encrypted file is written; the settings never touch
 * this machine's disk or the terminal. docs/HOSTING.md ("Rebuilding the host") restores it.
 *
 * Usage: bun scripts/host-env-backup.ts [--host USER@HOST] [--out DIRECTORY] [--identity KEY_FILE]
 *
 * With --identity (the private key), the new file is also decrypted in memory and compared with
 * what was read, proving the key opens it. The output names only the settings present, never values.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/** The production host, as the operator reaches it (docs/HOSTING.md). */
export const DEFAULT_HOST = "tarubot@tarubot.deconfined.com";
/** Settings a production `.env` must hold for the Compose file to start (docs/HOSTING.md). */
export const REQUIRED_SETTINGS = [
  "TARUBOT_IMAGE_TAG",
  "DATABASE_URL",
  "DATABASE_CA_CERT",
  "DISCORD_TOKEN",
] as const;
/** Settings a complete production `.env` also holds; their absence is reported, not refused. */
export const EXPECTED_SETTINGS = ["GITHUB_REPORTS_TOKEN", "HEALTHCHECKS_PING_URL"] as const;

export interface Options {
  host: string;
  out: string;
  identity: string | null;
}

/** Parse the command line; unknown arguments are refused rather than ignored. */
export function parseArgs(argv: readonly string[], home = homedir()): Options {
  const options: Options = {
    host: DEFAULT_HOST,
    out: `${home}/tarubot-cutover/env-backups`,
    identity: null,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag !== "--host" && flag !== "--out" && flag !== "--identity")
      throw new Error(`Unknown argument ${flag}. Use --host, --out or --identity.`);
    if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
    if (flag === "--host") options.host = value;
    else if (flag === "--out") options.out = value;
    else options.identity = value;
    index++;
  }
  return options;
}

/** The setting names a `.env` defines, in order; values (even multi-line ones) are skipped. */
export function settingNames(text: string): string[] {
  return [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gmu)].map((match) => match[1] ?? "");
}

/**
 * Refuse a `.env` that couldn't start production, naming what's missing, never a value. Returns
 * the expected settings that are absent, which the output reports.
 */
export function checkSettings(names: readonly string[]): string[] {
  const present = new Set(names);
  const missing = REQUIRED_SETTINGS.filter((name) => !present.has(name));
  if (missing.length) throw new Error(`The host's .env lacks ${missing.join(", ")}.`);
  return EXPECTED_SETTINGS.filter((name) => !present.has(name));
}

/** A sortable, UTC-stamped file name: tarubot-env-20260925T123456Z.age. */
export function backupName(now: Date): string {
  return `tarubot-env-${now
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d+Z$/u, "Z")}.age`;
}

/** The age public keys to encrypt for: every non-comment line of the recipients file. */
export function recipients(text: string): string[] {
  const keys = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (!keys.length || keys.some((key) => !/^age1[0-9a-z]{58}$/u.test(key)))
    throw new Error("ops/age-recipients.txt must list one or more age public keys (age1…).");
  return keys;
}

/** Run a command with `input` on stdin; resolve its stdout, or throw with its exit status. */
async function run(command: string[], input?: Uint8Array): Promise<Uint8Array> {
  const child = Bun.spawn(command, {
    stdin: input ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  if (input && child.stdin) {
    child.stdin.write(input);
    await child.stdin.end();
  }
  const output = new Uint8Array(await new Response(child.stdout).arrayBuffer());
  if ((await child.exited) !== 0) throw new Error(`${command[0]} failed (${child.exitCode}).`);
  return output;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  if (!Bun.which("age")) throw new Error("age is not installed (Ubuntu: sudo apt install age).");
  const recipientsFile = fileURLToPath(new URL("../ops/age-recipients.txt", import.meta.url));
  recipients(await Bun.file(recipientsFile).text());
  // Read the settings into memory only; BatchMode refuses rather than prompting for a password.
  const plain = await run(["ssh", "-o", "BatchMode=yes", options.host, "cat ~/tarubot/.env"]);
  const names = settingNames(new TextDecoder().decode(plain));
  const absent = checkSettings(names);
  process.umask(0o077);
  await mkdir(options.out, { recursive: true, mode: 0o700 });
  const file = `${options.out}/${backupName(new Date())}`;
  await run(["age", "--encrypt", "--recipients-file", recipientsFile, "--output", file], plain);
  await chmod(file, 0o600);
  const encrypted = new Uint8Array(await Bun.file(file).arrayBuffer());
  let verified: boolean | null = null;
  if (options.identity)
    verified =
      sha256(await run(["age", "--decrypt", "--identity", options.identity, file])) ===
      sha256(plain);
  console.log(
    JSON.stringify(
      {
        file,
        bytes: (await stat(file)).size,
        sha256: sha256(encrypted),
        settings: names,
        notSet: absent,
        verified,
      },
      null,
      2,
    ),
  );
  if (verified === false) throw new Error("The new copy did not decrypt to what was read.");
}
