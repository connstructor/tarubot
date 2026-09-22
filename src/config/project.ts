/** Build-local identity comes from the manifest copied by TypeScript into compiled output. */
import manifest from "../../package.json" with { type: "json" };

export const project = {
  version: manifest.version,
  license: manifest.license,
  repository: manifest.repository.url.replace("https://github.com/", "").replace(/\.git$/, ""),
  url: manifest.repository.url.replace(/\.git$/, ""),
  branch: "main",
} as const;
