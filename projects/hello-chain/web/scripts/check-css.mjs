// Asserts the production CSS really contains the design tokens and custom utilities.
// `next build` succeeds even when Tailwind silently drops a utility, so run this after a build:
//   pnpm build && pnpm check:css
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = ".next/static";
const REQUIRED = [
  [".font-display{", "display font utility"],
  [".text-display{", "display type size"],
  [".text-h2{", "h2 type size"],
  [".text-lead{", "lead type size"],
  [".bg-accent{", "accent colour utility"],
  ["--paper:", "paper colour token"],
  ["prefers-color-scheme:dark", "dark theme tokens"],
  [":focus-visible", "focus style"],
  [".flow-step", "how-it-works diagram"],
  ["Instrument Serif", "display font face"],
];

function cssFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return cssFiles(p);
    return p.endsWith(".css") ? [p] : [];
  });
}

let files;
try {
  files = cssFiles(ROOT);
} catch {
  console.error(`check-css: ${ROOT} not found; run \`pnpm build\` first`);
  process.exit(1);
}
const css = files.map((f) => readFileSync(f, "utf8")).join("\n").replace(/\s+/g, "");
const missing = REQUIRED.filter(([needle]) => !css.includes(needle.replace(/\s+/g, "")));
if (missing.length) {
  for (const [needle, what] of missing) console.error(`check-css: missing ${what} (${needle})`);
  process.exit(1);
}
console.log(`check-css: ${REQUIRED.length} required rules found in ${files.length} CSS file(s)`);
