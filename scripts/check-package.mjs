import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const [pack] = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
  }),
);
const paths = new Set(pack.files.map((file) => file.path));
assert.ok(manifest.keywords.includes("pi-package"));
assert.equal(manifest.private, undefined);
assert.equal(manifest.publishConfig.access, "public");
for (const entry of manifest.pi.extensions) {
  assert.ok(paths.has(entry.replace(/^\.\//, "")), `Missing entry: ${entry}`);
}
for (const path of ["package.json", "README.md", "LICENSE"]) {
  assert.ok(paths.has(path), `Missing package file: ${path}`);
}
for (const path of paths) {
  assert.ok(
    ["package.json", "README.md", "LICENSE"].includes(path) ||
      /^src\/.*\.ts$/.test(path),
    `Unexpected published file: ${path}`,
  );
}
console.log(`Package OK: ${pack.name}@${pack.version}, ${paths.size} files`);
for (const path of paths) console.log(`  ${path}`);
