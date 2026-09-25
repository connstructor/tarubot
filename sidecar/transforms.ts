/** Compatibility edits originally verified at 5b7eec6; every tracked upstream update revalidates them. */

/** The worker-side selector loader the rewritten imports call (2.19.0). */
const SELECTOR_RUNTIME = new URL("./selector-runtime.ts", import.meta.url).pathname;
/** Nodestone's static selector imports: `import * as name from "lodestone-css-selectors/x.json";` */
const SELECTOR_IMPORT =
  /^import \* as (\w+) from ["']lodestone-css-selectors\/([\w/-]+\.json)["'];?$/gmu;

/**
 * Every selector file the transformed parsers load at runtime, by repository path. The build reads
 * it after bundling, to package exactly these files as the bundled fallback and to check that
 * no static selector import was left behind.
 */
export const selectorImports = new Set<string>();

/**
 * Replace static selector imports with runtime loads (2.19.0), so a parser worker uses the active
 * upstream selectors rather than those bundled at build time. Nodestone spreads the imported objects
 * into its selector registries, which plain objects satisfy.
 */
export function rewriteSelectorImports(input: string): { output: string; paths: string[] } {
  const paths: string[] = [];
  const output = input.replace(SELECTOR_IMPORT, (_match, name: string, path: string) => {
    paths.push(path);
    return `const ${name} = __tarubotSelectors(${JSON.stringify(path)});`;
  });
  if (!paths.length) return { output: input, paths };
  return {
    output: `import { selectorFile as __tarubotSelectors } from ${JSON.stringify(SELECTOR_RUNTIME)};\n${output}`,
    paths,
  };
}

/** Apply only known source edits; changed upstream text must fail review rather than partially patch. */
export function transform(path: string, input: string): string {
  const selectors = rewriteSelectorImports(input);
  for (const file of selectors.paths) selectorImports.add(file);
  let output = selectors.output;
  const replace = (from: string, to: string): void => {
    // Exactly one match also prevents silently applying a fix to an unrelated parser path.
    if (output.split(from).length !== 2)
      throw new Error(`Upstream contract changed: ${path}: ${from}`);
    output = output.replace(from, to);
  };
  if (path.endsWith("/core/page-parser.ts")) {
    replace(
      "await axios.get(this.getURL(req)).catch((err: any) => {\n            throw new Error(err.response.status);\n        })",
      "await axios.get(this.getURL(req))",
    );
    replace(
      "const contextDOM = parseHTML(context);",
      "if (typeof context !== 'string') throw new Error('Missing page root');\n                const contextDOM = parseHTML(context);",
    );
    replace(
      "isPatch: typeof data === 'object'",
      "isPatch: data !== null && typeof data === 'object'",
    );
    replace("if (parsed.data) {", "if (parsed.data !== null && parsed.data !== undefined) {");
    replace(
      "if (!isNaN(value) && (+value).toString() === value) {\n                        value = +value;\n                    }",
      "// Preserve captured values, particularly unsigned 64-bit IDs, as strings.",
    );
    replace(
      "return (isNaN(+res) ? res : +res) || null;",
      "return res; // Distinguish explicit zero/empty text from a missing selector.",
    );
    replace(
      "}).filter((row: any | null) => !!row)",
      "}) // Keep malformed rows visible to the validating adapter.",
    );
  }
  if (path.endsWith("/search/character-search.ts")) {
    replace("logger.info(req.query);", "// Search inputs are not logged by the sidecar.");
    replace(`\${req.query.name}`, `\${encodeURIComponent(req.query.name.toString())}`);
    replace(`\${req.query.dc}`, `\${encodeURIComponent(req.query.dc.toString())}`);
    replace(`\${req.query.server}`, `\${encodeURIComponent(req.query.server.toString())}`);
  }
  if (path.endsWith("/core/paginated-page-parser.ts")) {
    replace("+baseParse.CurrentPage < 1", "+baseParse.CurrentPage <= 1");
  }
  if (path.endsWith("/logger/logger.ts"))
    return "export default { info() {}, error() {}, warn() {} };";
  return output;
}
