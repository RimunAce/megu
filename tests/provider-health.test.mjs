import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const raw = (await readFile('src/lib/providerHealth.ts', 'utf8'))
  .replace(/^import .*;\r?\n/gm, '');
const preamble = `
const isTauri = false;
const invoke = async () => [];
const PROVIDERS = ['anikoto', 'reanime', 'anipm', 'kaa'];
function optionHost(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return 'unknown'; } }
`;
const js = stripTypeScriptTypes(`${preamble}\n${raw}`);
const { scoreHealthRow, rankProviders, rankPlayerOptions } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('demotes providers with recent consecutive failures and promotes reliable ones', () => {
  const now = 10_000;
  const health = [
    { provider: 'anikoto', server_host: 'broken.example', success_count: 1, failure_count: 4, consecutive_failures: 3, avg_ttff_ms: null, last_success_at: 8000, last_failure_at: now - 30 },
    { provider: 'anipm', server_host: 'fast.example', success_count: 8, failure_count: 0, consecutive_failures: 0, avg_ttff_ms: 900, last_success_at: now - 10, last_failure_at: null },
  ];
  const ranked = rankProviders(['anikoto', 'reanime', 'anipm', 'kaa'], health, null, now);
  assert.equal(ranked[0], 'anipm');
  assert.equal(ranked[ranked.length - 1], 'anikoto');
});

test('decays failure penalty after 20 minutes so recovered providers can be retried', () => {
  const row = { provider: 'anipm', server_host: 'cdn.example', success_count: 2, failure_count: 2, consecutive_failures: 2, avg_ttff_ms: null, last_success_at: 1000, last_failure_at: 2000 };
  const freshPenalty = scoreHealthRow(row, 2060);
  const decayedPenalty = scoreHealthRow(row, 4000);
  assert.ok(decayedPenalty > freshPenalty, `expected decayed (${decayedPenalty}) > fresh (${freshPenalty})`);
});

test('ranks healthy direct HLS above embeds and demotes failing hosts', () => {
  const now = 50_000;
  const options = [
    { url: 'https://bad-cdn.example/master.m3u8', label: 'Bad · Direct HLS', kind: 'hls' },
    { url: 'https://good-embed.example/videojs/1', label: 'Good Embed', kind: 'embed' },
    { url: 'https://good-cdn.example/master.m3u8', label: 'Good · Direct HLS', kind: 'hls' },
  ];
  const health = [
    { provider: 'anikoto', server_host: 'bad-cdn.example', success_count: 0, failure_count: 4, consecutive_failures: 4, avg_ttff_ms: null, last_success_at: null, last_failure_at: now - 5 },
    { provider: 'anikoto', server_host: 'good-cdn.example', success_count: 5, failure_count: 0, consecutive_failures: 0, avg_ttff_ms: 1200, last_success_at: now - 20, last_failure_at: null },
    { provider: 'anikoto', server_host: 'good-embed.example', success_count: 3, failure_count: 0, consecutive_failures: 0, avg_ttff_ms: 2000, last_success_at: now - 20, last_failure_at: null },
  ];
  const ranked = rankPlayerOptions('anikoto', options, health, now);
  assert.deepEqual(ranked.map((o) => o.label), ['Good · Direct HLS', 'Good Embed', 'Bad · Direct HLS']);
});
