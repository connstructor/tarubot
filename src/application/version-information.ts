/** Report the installed release independently from the latest published repository history. */
import { project } from "../config/project.js";
import { DEFAULT_COMMIT_COUNT, type GitHubHistory } from "../infrastructure/github/client.js";

export class VersionInformation {
  constructor(private readonly github: GitHubHistory) {}

  /** This public project information needs neither FC setup nor officer privileges. */
  async get(count = DEFAULT_COMMIT_COUNT) {
    return { ...project, ...(await this.github.recent(count)) };
  }
}
export type VersionReport = Awaited<ReturnType<VersionInformation["get"]>>;
