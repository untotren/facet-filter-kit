import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFilter } from '../src/facetFilter.js';
import { mulberry32 } from '../scripts/generate-fixture.js';
import items from '../fixtures/items.js';
import schema from '../fixtures/schema.js';

const RUNS = 2000;
const SEEDS = [1, 220, 0xc0ffee];

// Keys deliberately include characters that need escaping in a query string.
const awkwardSchema = [
  { key: 'tags', type: 'tags', label: 'Tags' },
  { key: 'kind', type: 'enum', label: 'Kind' },
  { key: 'a b&c=d', type: 'enum', label: 'Awkward' },
  { key: 'price', type: 'range', label: 'Price' },
  { key: 'x~y', type: 'range', label: 'Tilde' },
  { key: 'ünï?#', type: 'tags', label: 'Unicode' },
  { key: '__proto__', type: 'enum', label: 'Proto' },
];
const awkward = createFilter([], awkwardSchema);

const ALPHABET = [
  'a', 'b', 'Z', '0', '9', ' ', '+', '&', '=', '?', '#', '%', '%20', '~', ',', '.', '-', '_', '/', '\\',
  '"', "'", '<', '>', '\n', '\t', 'é', 'ß', '中', '🙂', '👩‍💻', '\u0000', ' ', '﻿', '%E0', '+%2B',
];
const SPECIAL_NUMBERS = [0, -0, 1, -1, 0.1, -0.5, 1e21, -1e21, 1e-7, 5e-324, Number.MAX_VALUE, -Number.MAX_VALUE,
  Number.MAX_SAFE_INTEGER, 123.456, 2 ** 53 + 2];

function generator(seed) {
  const random = mulberry32(seed);
  const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
  const string = () => {
    const length = int(0, 6);
    let out = '';
    for (let i = 0; i < length; i++) out += ALPHABET[int(0, ALPHABET.length - 1)];
    return out;
  };
  const number = () => {
    const roll = random();
    if (roll < 0.25) return null;
    if (roll < 0.45) return SPECIAL_NUMBERS[int(0, SPECIAL_NUMBERS.length - 1)];
    if (roll < 0.7) return int(-1000, 1000);
    // Arbitrary doubles across many magnitudes.
    return (random() - 0.5) * 10 ** int(-12, 30);
  };
  return function state(filter) {
    const out = {};
    for (const facet of filter.facets) {
      let value;
      if (facet.type === 'range') {
        value = { min: number(), max: number() };
      } else {
        value = [];
        const count = int(0, 4);
        while (value.length < count) {
          const candidate = facet.options.length && random() < 0.5
            ? facet.options[int(0, facet.options.length - 1)].value
            : string();
          if (!value.includes(candidate)) value.push(candidate);
        }
      }
      Object.defineProperty(out, facet.key, { value, enumerable: true, writable: true, configurable: true });
    }
    return out;
  };
}

for (const seed of SEEDS) {
  test(`property: fromQuery(toQuery(state)) deep-equals state (seed ${seed})`, () => {
    const nextState = generator(seed);
    for (const filter of [awkward, createFilter(items, schema)]) {
      for (let run = 0; run < RUNS; run++) {
        const state = nextState(filter);
        const query = filter.toQuery(state);
        const back = filter.fromQuery(query);
        assert.deepStrictEqual(back, state, `seed ${seed} run ${run}: ${query}`);
        // And the query itself is canonical.
        assert.equal(filter.toQuery(back), query);
        assert.deepStrictEqual(filter.fromQuery(`?${query}`), state);
      }
    }
  });
}

test('property: round trip preserves apply() results', () => {
  const filter = createFilter(items, schema);
  const nextState = generator(42);
  for (let run = 0; run < 300; run++) {
    const state = nextState(filter);
    assert.deepEqual(filter.apply(filter.fromQuery(filter.toQuery(state))), filter.apply(state));
  }
});

test('the empty state serializes to an empty string', () => {
  const filter = createFilter(items, schema);
  assert.equal(filter.toQuery(filter.emptyState()), '');
  assert.equal(filter.toQuery({}), '');
  assert.deepStrictEqual(filter.fromQuery(''), filter.emptyState());
  assert.deepStrictEqual(filter.fromQuery('?'), filter.emptyState());
});

test('query format is readable and in schema order', () => {
  const filter = createFilter(items, schema);
  const query = filter.toQuery({
    year: { min: 2000, max: null },
    tags: ['eco', 'gift'],
    category: ['Frostmere'],
    price: { min: -0, max: 12.5 },
  });
  assert.equal(query, 'category=Frostmere&tags=eco&tags=gift&price=-0~12.5&year=2000~');
});

test('negative zero survives the round trip', () => {
  const filter = createFilter(items, schema);
  const back = filter.fromQuery(filter.toQuery({ price: { min: -0, max: 0 } }));
  assert.ok(Object.is(back.price.min, -0));
  assert.ok(Object.is(back.price.max, 0));
});

test('fromQuery tolerates hostile or malformed input', () => {
  const filter = createFilter(items, schema);
  const state = filter.fromQuery(
    'nope=1&category=%E0%A4%A&price=abc~1&price=5~10&price=1~2&rating=0x10~&year=Infinity~&tags&tags=eco&tags=eco&tags=a+b&&=',
  );
  assert.deepStrictEqual(state, {
    category: [],
    tags: ['', 'eco', 'a b'],
    region: [],
    price: { min: 5, max: 10 },
    rating: { min: null, max: null },
    year: { min: null, max: null },
  });
  assert.throws(() => filter.fromQuery(null), /query must be a string/);
});

test('toQuery rejects invalid states instead of producing lossy output', () => {
  const filter = createFilter(items, schema);
  assert.throws(() => filter.toQuery({ tags: ['\uDC00'] }), /well-formed/);
  assert.throws(() => filter.toQuery({ price: { min: Infinity, max: null } }), /finite/);
  assert.throws(() => filter.toQuery({ bogus: [] }), /unknown facet/);
});
