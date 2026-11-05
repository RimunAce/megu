import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = (await readFile('src/lib/updater.ts', 'utf8')).replace(/^import .*;\r?\n/gm, '');
const script = stripTypeScriptTypes(`const { invoke, isTauri, getVersion, check, create } = globalThis.updaterMocks;\n${source}`);
const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) };
globalThis.document = { querySelector: () => null };
let calls = 0;
let mockUpdate = null;
globalThis.updaterMocks = {
  invoke: async () => true, isTauri: () => true, getVersion: async () => '0.1.0',
  check: async () => { calls++; return mockUpdate; },
  create: (init) => { let state = init(); const store = () => state; store.getState = () => state; store.setState = (value) => { state = { ...state, ...(typeof value === 'function' ? value(state) : value) }; }; return store; },
};
const updater = await import(`data:text/javascript;base64,${Buffer.from(script).toString('base64')}`);

test('defaults to checking without downloading and persists mode', () => {
  assert.equal(updater.useUpdater.getState().mode, 'check');
  updater.setUpdateMode('manual');
  assert.equal(storage.get('megu.updates.mode'), 'manual');
});

test('manual mode suppresses automatic checks', async () => {
  await updater.initializeUpdater();
  assert.equal(calls, 0);
  assert.equal(updater.useUpdater.getState().version, '0.1.0');
});

test('manual check reports release and download waits for approval', async () => {
  let downloads = 0;
  mockUpdate = { version: '0.2.0', body: 'Changes', close: async () => {}, download: async (callback) => { downloads++; callback({event:'Started',data:{contentLength:10}}); callback({event:'Progress',data:{chunkLength:10}}); }, install: async () => {} };
  await updater.checkForUpdates();
  assert.equal(updater.useUpdater.getState().phase, 'available');
  assert.equal(downloads, 0);
  await updater.downloadUpdate();
  assert.equal(updater.useUpdater.getState().phase, 'ready');
  assert.equal(updater.useUpdater.getState().downloaded, 10);
  assert.equal(downloads, 1);
});

test('installation is blocked while a player is open', async () => {
  globalThis.document.querySelector = () => ({});
  await updater.installUpdate();
  assert.match(updater.useUpdater.getState().error, /Close the player/);
  assert.equal(updater.useUpdater.getState().phase, 'ready');
});

test('automatic download mode downloads an available update after checking', async () => {
  let downloads = 0;
  mockUpdate = { version: '0.3.0', close: async () => {}, download: async () => { downloads++; }, install: async () => {} };
  updater.useUpdater.setState({ phase: 'current', lastChecked: null });
  updater.setUpdateMode('download');
  await updater.automaticCheck();
  assert.equal(downloads, 1);
  assert.equal(updater.useUpdater.getState().phase, 'ready');
});

test('failed downloads remain available for retry', async () => {
  mockUpdate = { version: '0.4.0', close: async () => {}, download: async () => { throw new Error('offline'); } };
  updater.useUpdater.setState({ phase: 'current', lastChecked: null });
  updater.setUpdateMode('check');
  await updater.checkForUpdates();
  await updater.downloadUpdate();
  assert.equal(updater.useUpdater.getState().phase, 'available');
  assert.match(updater.useUpdater.getState().error, /offline/);
});
