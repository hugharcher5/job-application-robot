import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");
mkdirSync("dist", { recursive: true });
cpSync("static", "dist", { recursive: true });

const common = { bundle: true, target: "chrome120", outdir: "dist", logLevel: "info" };
const contexts = await Promise.all([
  // Service worker and side panel load as ES modules.
  esbuild.context({ ...common, format: "esm", entryPoints: { background: "src/background.js", sidepanel: "src/sidepanel.js" } }),
  // The content script is injected with chrome.scripting, which runs classic scripts.
  esbuild.context({ ...common, format: "iife", entryPoints: { content: "src/content.js" } }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
