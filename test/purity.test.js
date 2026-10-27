import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE_URL = new URL('../src/facetFilter.js', import.meta.url);
const source = readFileSync(SOURCE_URL, 'utf8');
const code = source.replace(/\/\/.*$/gm, '');

test('module source has no network, analytics, storage or global access', () => {
  const forbidden = [
    /\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/, /\bimport\s*\(/,
    /\bwindow\b/, /\bglobalThis\b/, /\bself\b/, /\bdocument\b/, /localStorage/, /sessionStorage/, /\bnavigator\b/,
    /\beval\s*\(/, /new\s+Function/, /innerHTML/, /outerHTML/, /insertAdjacentHTML/,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(code, pattern);
});

test('module has no imports (dependency-free)', () => {
  assert.doesNotMatch(code, /^\s*import\s/m);
});

test('importing the module defines no globals', async () => {
  const before = new Set(Object.getOwnPropertyNames(globalThis));
  await import(`${SOURCE_URL.href}?fresh=${Date.now()}`);
  const added = Object.getOwnPropertyNames(globalThis).filter((name) => !before.has(name));
  assert.deepEqual(added, []);
});

test('module exports only createFilter, mount and the default facetFilter object', async () => {
  const mod = await import(SOURCE_URL.href);
  assert.deepEqual(Object.keys(mod).sort(), ['createFilter', 'default', 'mount']);
});
