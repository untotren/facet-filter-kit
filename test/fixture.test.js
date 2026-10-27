import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import items from '../fixtures/items.js';
import schema from '../fixtures/schema.js';
import { createFilter } from '../src/facetFilter.js';
import { CATEGORIES, ITEM_COUNT, OUTPUT_PATH, generateItems, renderModule } from '../scripts/generate-fixture.js';

test('committed fixture matches the generator byte for byte', () => {
  assert.equal(readFileSync(OUTPUT_PATH, 'utf8'), renderModule(generateItems()));
});

test('fixture has 250 items across six fictional categories', () => {
  assert.equal(ITEM_COUNT, 250);
  assert.equal(items.length, 250);
  assert.equal(new Set(items.map((item) => item.id)).size, 250);
  const categories = new Set(items.map((item) => item.fields.category));
  assert.deepEqual([...categories].sort(), [...CATEGORIES].sort());
  assert.equal(CATEGORIES.length, 6);
});

test('fixture loads into the filter with the shipped schema', () => {
  const filter = createFilter(items, schema);
  assert.equal(filter.apply({}).length, 250);
  const category = filter.facets.find((f) => f.key === 'category');
  assert.equal(category.options.length, 6);
  const perCategory = CATEGORIES.map((c) => filter.apply({ category: [c] }).length);
  assert.equal(perCategory.reduce((a, b) => a + b, 0), 250);
  assert.ok(perCategory.every((n) => n > 0));
});

test('generator is deterministic per seed and varies across seeds', () => {
  assert.deepEqual(generateItems(7), generateItems(7));
  assert.notDeepEqual(generateItems(7), generateItems(8));
});
