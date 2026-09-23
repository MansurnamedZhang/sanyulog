import { build } from "esbuild";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
await build({
  entryPoints: ["src/rich-editor.js"],
  bundle: true,
  format: "esm",
  target: ["es2022"],
  supported: { "template-literal": false },
  minify: true,
  outfile: "static/vendor/rich-editor.js",
  legalComments: "linked",
});
await build({
  entryPoints: ["src/mermaid-runtime.js"],
  bundle: true,
  format: "esm",
  target: ["es2022"],
  minify: true,
  outfile: "static/vendor/mermaid-runtime.js",
  legalComments: "linked",
});
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const notices = [
  "Bundled browser runtime dependencies. See package-lock.json for exact versions.\n",
];
for (const [directory, info] of Object.entries(lock.packages)) {
  if (!directory || info.dev) continue;
  const candidates = [
    "LICENSE",
    "LICENSE.md",
    "LICENSE.txt",
    "license",
    "license.md",
    "LICENSE-MIT",
  ];
  const license = candidates
    .map((name) => path.join(directory, name))
    .find(existsSync);
  notices.push(
    `${directory.replace(/^node_modules\//, "")} ${info.version} (${info.license || "see license"})\n${license ? readFileSync(license, "utf8") : "Refer to upstream package license."}`,
  );
}
writeFileSync(
  "static/vendor/rich-editor.LICENSE.txt",
  notices.join("\n\n---\n\n"),
);
