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
