import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");
mkdirSync("dist", { recursive: true });
cpSync("static", "dist", { recursive: true });

const ctx = await esbuild.context({
  entryPoints: {
    background: "src/background.js",
    content: "src/content.js",
    sidepanel: "src/sidepanel.js",
  },
  bundle: true,
  format: "esm",
  target: "chrome120",
  outdir: "dist",
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
