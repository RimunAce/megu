import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const source = await readFile('src/lib/streamProxy.ts','utf8');
const js = stripTypeScriptTypes(source, { mode: 'strip' });
const { proxyStreamUrl } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('builds a single-segment loopback path with encoded upstream url', () => {
  const url = proxyStreamUrl('http://127.0.0.1:4321', 'abc-123', 'https://cdn.example.org/hls/master.m3u8?token=a/b&c=1');
  assert.equal(url, 'http://127.0.0.1:4321/p/abc-123/https%3A%2F%2Fcdn.example.org%2Fhls%2Fmaster.m3u8%3Ftoken%3Da%2Fb%26c%3D1');
});

test('rejects non-loopback proxy bases and bad sessions', () => {
  assert.throws(() => proxyStreamUrl('http://192.168.1.5:4321', 's', 'https://example.com/'), /Invalid stream proxy/);
  assert.throws(() => proxyStreamUrl('https://127.0.0.1.evil.com:4321', 's', 'https://example.com/'), /Invalid stream proxy/);
  assert.throws(() => proxyStreamUrl('http://127.0.0.1:4321', 'a/b', 'https://example.com/'), /Invalid stream session/);
  assert.throws(() => proxyStreamUrl('http://127.0.0.1:4321', '', 'https://example.com/'), /Invalid stream session/);
});

test('encoded path round-trips through decodeURIComponent like the rust percent_decode', () => {
  const upstream = 'https://edge.example.net/seg/001.ts?x=%20#f';
  const url = proxyStreamUrl('http://127.0.0.1:9', 'sess', upstream);
  const encoded = url.split('/p/sess/')[1];
  assert.equal(decodeURIComponent(encoded), upstream);
  assert.ok(!encoded.includes('/'));
});
