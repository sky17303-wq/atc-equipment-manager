const fs = require("node:fs/promises");

const { DATA_PATH, RUNTIME_STATE_PATH } = require("./config");

let seedCache = null;

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function getJsonSeed() {
  if (!seedCache) {
    seedCache = JSON.parse(await fs.readFile(DATA_PATH, "utf8"));
  }
  return seedCache;
}

async function writeJsonRuntimeState(state) {
  await fs.writeFile(RUNTIME_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

module.exports = {
  readJsonFile,
  getJsonSeed,
  writeJsonRuntimeState
};
