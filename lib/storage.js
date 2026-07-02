const {
  DEFAULT_SETTINGS,
  RUNTIME_APPLICATIONS_PATH,
  RUNTIME_RETURNS_PATH,
  RUNTIME_STATE_PATH
} = require("./config");
const { mergeById } = require("./utils");
const { readJsonFile, getJsonSeed, writeJsonRuntimeState } = require("./storage-json");
const { postgresEnabled, getPostgresSeed, savePostgresRuntimeState } = require("./storage-postgres");

async function getSeed() {
  if (postgresEnabled()) {
    return getPostgresSeed();
  }
  return getJsonSeed();
}

function createRuntimeState() {
  return {
    applications: [],
    reservations: [],
    loans: [],
    returnInspections: [],
    repairTickets: [],
    inventoryItems: [],
    inventoryOverrides: {},
    organizations: [],
    members: [],
    events: [],
    settings: { ...DEFAULT_SETTINGS },
    updatedAt: null
  };
}

function normalizeRuntimeState(value) {
  const state = { ...createRuntimeState(), ...(value || {}) };
  state.applications = Array.isArray(state.applications) ? state.applications : [];
  state.reservations = Array.isArray(state.reservations) ? state.reservations : [];
  state.loans = Array.isArray(state.loans) ? state.loans : [];
  state.returnInspections = Array.isArray(state.returnInspections) ? state.returnInspections : [];
  state.repairTickets = Array.isArray(state.repairTickets) ? state.repairTickets : [];
  state.inventoryItems = Array.isArray(state.inventoryItems) ? state.inventoryItems : [];
  state.inventoryOverrides = state.inventoryOverrides && typeof state.inventoryOverrides === "object"
    ? state.inventoryOverrides
    : {};
  state.organizations = Array.isArray(state.organizations) ? state.organizations : [];
  state.members = Array.isArray(state.members) ? state.members : [];
  state.events = Array.isArray(state.events) ? state.events : [];
  state.settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
  return state;
}

async function getRuntimeState() {
  if (postgresEnabled()) {
    return createRuntimeState();
  }
  const state = normalizeRuntimeState(await readJsonFile(RUNTIME_STATE_PATH, null));
  if (!state.updatedAt) {
    const legacyApplications = await readJsonFile(RUNTIME_APPLICATIONS_PATH, []);
    const legacyReturns = await readJsonFile(RUNTIME_RETURNS_PATH, []);
    if (Array.isArray(legacyApplications) && legacyApplications.length) {
      state.applications = mergeById([...state.applications, ...legacyApplications]);
    }
    if (Array.isArray(legacyReturns) && legacyReturns.length) {
      state.returnInspections = mergeById([...state.returnInspections, ...legacyReturns]);
    }
  }
  return state;
}

async function saveRuntimeState(state) {
  const normalized = normalizeRuntimeState(state);
  normalized.updatedAt = new Date().toISOString();
  if (postgresEnabled()) {
    await savePostgresRuntimeState(normalized);
    return;
  }
  await writeJsonRuntimeState(normalized);
}

async function getRuntimeApplications() {
  const state = await getRuntimeState();
  return state.applications;
}

async function saveRuntimeApplications(applications) {
  const state = await getRuntimeState();
  state.applications = applications;
  await saveRuntimeState(state);
}

async function getRuntimeReturns() {
  const state = await getRuntimeState();
  return state.returnInspections;
}

async function saveRuntimeReturns(returns) {
  const state = await getRuntimeState();
  state.returnInspections = returns;
  await saveRuntimeState(state);
}

module.exports = {
  getSeed,
  createRuntimeState,
  normalizeRuntimeState,
  getRuntimeState,
  saveRuntimeState,
  getRuntimeApplications,
  saveRuntimeApplications,
  getRuntimeReturns,
  saveRuntimeReturns
};
