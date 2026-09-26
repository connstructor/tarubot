// Static documentation site: built into site/dist and published to GitHub Pages under /tarubot/.
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";

export default defineConfig({
  site: "https://deconfined.github.io",
  base: "/tarubot",
  integrations: [
    starlight({
      title: "TaruBot",
      description: "A Discord bot for Final Fantasy XIV Free Companies.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/deconfined/tarubot" }],
      editLink: { baseUrl: "https://github.com/deconfined/tarubot/edit/main/site/" },
      // Fails the build on broken internal links and #anchors; external links are not checked.
      plugins: [starlightLinksValidator()],
      // Starlight 0.39+ accepts autogenerate only inside a group's items array.
      sidebar: [
        { label: "Use TaruBot", items: [{ autogenerate: { directory: "use" } }] },
        { label: "Run a server", items: [{ autogenerate: { directory: "admin" } }] },
        { label: "Deploy and operate", items: [{ autogenerate: { directory: "deploy" } }] },
        {
          label: "Architecture and design",
          items: [{ autogenerate: { directory: "architecture" } }],
        },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
        {
          label: "Project",
          items: [
            { label: "Roadmap", slug: "project/roadmap" },
            { label: "Thank you", slug: "project/credits" },
            {
              label: "Changelog",
              link: "https://github.com/deconfined/tarubot/blob/main/CHANGELOG.md",
            },
            {
              label: "Security policy",
              link: "https://github.com/deconfined/tarubot/security/policy",
            },
            {
              label: "License (AGPL-3.0)",
              link: "https://github.com/deconfined/tarubot/blob/main/LICENSE",
            },
          ],
        },
      ],
    }),
  ],
});
