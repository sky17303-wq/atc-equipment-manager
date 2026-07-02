// 프로젝트 JS 파일 전체를 node --check 로 문법 검사한다.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function listJsFiles(dir) {
  return fs.readdirSync(path.join(ROOT, dir))
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(dir, name));
}

const targets = [
  "server.js",
  path.join("public", "app.js"),
  ...listJsFiles("lib"),
  ...listJsFiles("scripts")
];

let failed = false;
for (const target of targets) {
  try {
    execFileSync(process.execPath, ["--check", path.join(ROOT, target)], { stdio: "pipe" });
    console.log(`ok   ${target}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${target}`);
    console.error(String(error.stderr || error.message));
  }
}

if (failed) process.exit(1);
