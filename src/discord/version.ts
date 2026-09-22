/** Keep release/history output readable and inside Discord embed limits for ten commits. */
import { escapeMarkdown } from "discord.js";
import type { InteractionEditReplyOptions } from "discord.js";
import type { VersionReport } from "../application/version-information.js";

export function versionReply(report: VersionReport): InteractionEditReplyOptions {
  return {
    allowedMentions: { parse: [] },
    embeds: [
      {
        title: `TaruBot v${report.version}`,
        url: report.url,
        description: `${
          report.warning ??
          (report.commits.length
            ? `Latest ${report.commits.length} commits on [${report.repository}](${report.url}) · \`${report.branch}\``
            : "No commits are available from the GitHub repository.")
        }\n\n[Source code](${report.url}) · [${report.license}](${report.url}/blob/${report.branch}/LICENSE)`,
        fields: report.commits.map((commit) => {
          // Truncate before escaping; 100 Unicode code points remain below the 256-unit name limit.
          const title = [...commit.title];
          const summary = title.slice(0, 100).join("") + (title.length > 100 ? "…" : "");
          return {
            name: escapeMarkdown(summary),
            value: `[${commit.sha.slice(0, 7)}](${commit.url})${commit.verified ? " ✅" : ""}`,
          };
        }),
        footer: { text: "✅ GitHub-verified signature · History cached up to 5 minutes" },
        timestamp: report.checkedAt,
      },
    ],
  };
}
