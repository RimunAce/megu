import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const raw = (await readFile('src/lib/sourceResolver.ts', 'utf8'))
  .replace(/^import .*;\r?\n/gm, '');
const preamble = `
const PROVIDERS = ['anikoto', 'reanime', 'anipm', 'working'];
async function getEpisodes(mediaId, provider) {
  if (provider === 'working') return { episodes: { sub: [{ id: 'watch/working/1/sub/working-1', number: 1, title: 'Ep 1' }] } };
  throw new Error('Provider unavailable');
}
async function getStreams(mediaId, provider, audio, episode) {
  if (provider === 'working') return [{ type: 'hls', url: 'https://cdn.example/master.m3u8' }];
  throw new Error('Stream unavailable');
}
function embedOptions(streams) {
  return streams.map((s) => ({ url: s.url, label: 'Direct HLS', kind: 'hls' }));
}
function rankPlayerOptions(provider, options, health) {
  return options;
}
function rankProviders(providers, health) {
  return providers;
}
`;
const js = stripTypeScriptTypes(`${preamble}\n${raw}`);
const { findFallbackProviderSources } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('fallback probe resolves the next provider', async () => {
  const result = await findFallbackProviderSources({
    mediaId: 1,
    episodeNumber: 1,
    audio: 'sub',
    excludeProviders: ['anikoto'],
    health: [],
    maxAttempts: 4,
  });
  assert.ok(result, 'probe should find a fallback provider');
  assert.equal(result.provider, 'working');
  assert.equal(result.options.length, 1);
});

test('a stalled provider does not block fallback to a later provider', async () => {
  const preamble2 = `
const PROVIDERS = ['hang', 'working'];
async function getEpisodes(mediaId, provider, signal) {
  if (provider === 'hang') return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  if (provider === 'working') return { episodes: { sub: [{ id: 'watch/working/1/sub/working-1', number: 1, title: 'Ep 1' }] } };
  throw new Error('Provider unavailable');
}
async function getStreams(mediaId, provider, audio, episode) {
  if (provider === 'working') return [{ type: 'hls', url: 'https://cdn.example/master.m3u8' }];
  throw new Error('Stream unavailable');
}
function embedOptions(streams) {
  return streams.map((s) => ({ url: s.url, label: 'Direct HLS', kind: 'hls' }));
}
function rankPlayerOptions(provider, options, health) {
  return options;
}
function rankProviders(providers, health) {
  return providers;
}
`;
  const js2 = stripTypeScriptTypes(`${preamble2}\n${raw}`);
  const mod = await import(`data:text/javascript;base64,${Buffer.from(js2).toString('base64')}`);
  const result = await Promise.race([
    mod.findFallbackProviderSources({ mediaId: 1, episodeNumber: 1, audio: 'sub', excludeProviders: [], health: [] }),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('fallback probe hung on the stalled provider')), 5000)),
  ]);
  assert.equal(result.provider, 'working');
});

test('prefers full episode coverage over a fast partial episode list when expectedEpisodes is known', async () => {
  const preamble3 = `
const PROVIDERS = ['partial', 'complete'];
async function getEpisodes(mediaId, provider) {
  if (provider === 'partial') {
    return { episodes: { sub: [{ id: 'p-1', number: 1, title: 'Ep 1' }, { id: 'p-2', number: 2, title: 'Ep 2' }] } };
  }
  if (provider === 'complete') {
    await new Promise((r) => setTimeout(r, 25));
    return { episodes: { sub: Array.from({ length: 10 }, (_, i) => ({ id: 'c-' + (i + 1), number: i + 1, title: 'Ep ' + (i + 1) })) } };
  }
  throw new Error('Provider unavailable');
}
async function getStreams() { return []; }
function embedOptions(streams) { return streams; }
function rankPlayerOptions(_p, options) { return options; }
function rankProviders(providers) { return providers; }
`;
  const js3 = stripTypeScriptTypes(`${preamble3}\n${raw}`);
  const mod = await import(`data:text/javascript;base64,${Buffer.from(js3).toString('base64')}`);
  const result = await mod.findAvailableProviderForEpisodes({
    mediaId: 195539,
    audio: 'sub',
    excludeProviders: [],
    health: [],
    expectedEpisodes: 10,
  });
  assert.ok(result);
  assert.equal(result.provider, 'complete');
  assert.equal(result.episodes.length, 10);
});
