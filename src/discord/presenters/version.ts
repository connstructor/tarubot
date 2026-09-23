/**
 * The /version presenter (approved guests#54, with the gen.py rewrites): the running release, up
 * to ten recent GitHub commits with '· ✓ verified' on signature-verified ones, and the source and
 * license links. Info with commits, warning while GitHub history is unavailable, neutral when it
 * returned none; the embed is stamped with when the history was read. Pure.
 */
import type { VersionReport } from "../../application/version-information.js";
import { code, count, link, titleText } from "./format.js";
import { reply, type Presented, type ReplySpec } from "./reply.js";
import { SEPARATOR, VERIFIED } from "./style.js";

/**
 * Every /version reply kind, with whether its embed carries a timestamp: approved guests#54 does
 * (the history's read time), and so do its unavailable and empty variants (C11).
 */
const TIMESTAMP = {
  "version.commits": true,
  "version.unavailable": true,
  "version.empty": true,
} as const satisfies Record<string, boolean>;

/** A /version reply state; tests catalogue one case per kind. */
export type VersionReplyKind = keyof typeof TIMESTAMP;

/** Every /version reply kind, for catalog completeness checks. */
export const VERSION_REPLY_KINDS = Object.keys(TIMESTAMP) as readonly VersionReplyKind[];

/** A commit title as a field name: escaped inline markdown, at most 100 characters. */
const COMMIT_TITLE = 100;

/**
 * /version. Each commit is a field named by its escaped title (100 characters at most) whose value
 * links the short SHA, followed by '· ✓ verified' when GitHub verified its signature; the footer
 * explains the marker ('✓ verified = GitHub-verified signature · History cached up to 5 minutes'),
 * says when a failed read is retried, or drops the legend when there are no commits.
 */
export function versionReply(report: VersionReport): Presented {
  const commits = report.commits;
  const kind: VersionReplyKind = report.warning
    ? "version.unavailable"
    : commits.length
      ? "version.commits"
      : "version.empty";
  const lead =
    report.warning ??
    (commits.length
      ? `Latest ${count(commits.length, "commit")} on ${link(report.repository, report.url)} · ${code(report.branch)}`
      : "No commits are available from the GitHub repository.");
  const spec: Omit<ReplySpec, "timestamp"> = {
    tone: report.warning ? "warning" : commits.length ? "info" : "neutral",
    title: `TaruBot v${report.version}`,
    url: report.url,
    // Joined here: an array description drops empty entries, and this is a paragraph break.
    description: [
      lead,
      "",
      `${link("Source code", report.url)} · ${link(report.license, `${report.url}/blob/${report.branch}/LICENSE`)}`,
    ].join("\n"),
    fields: commits.map((commit) => ({
      name: titleText(commit.title, COMMIT_TITLE),
      value: `${link(commit.sha.slice(0, 7), commit.url)}${commit.verified ? `${SEPARATOR}${VERIFIED}` : ""}`,
    })),
    footer: report.warning
      ? "History retried after 1 minute"
      : commits.length
        ? `${VERIFIED} = GitHub-verified signature${SEPARATOR}History cached up to 5 minutes`
        : "History cached up to 5 minutes",
  };
  return reply({ ...spec, timestamp: TIMESTAMP[kind] ? new Date(report.checkedAt) : null });
}
