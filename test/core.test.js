import { test } from 'node:test';
import assert from 'node:assert/strict';
import facetFilter, { createFilter } from '../src/facetFilter.js';
import items from '../fixtures/items.js';
import schema from '../fixtures/schema.js';

const small = [
  { id: 'a', title: 'Alpha', tags: ['red', 'big'], fields: { kind: 'tool', price: 10, size: 'L' } },
  { id: 'b', title: 'Beta', tags: ['blue'], fields: { kind: 'toy', price: 25 } },
  { id: 'c', title: 'Alpha', tags: ['red'], fields: { kind: 'tool', price: 40, size: 3 } },
  { id: 'd', title: 'Delta', tags: [], fields: { kind: 'book', price: 'n/a' } },
  { id: 'e', title: 'Alpha', tags: ['red', 'big', 'blue'], fields: { kind: 'toy', price: 10 } },
];
const smallSchema = [
  { key: 'tags', type: 'tags', label: 'Tags' },
  { key: 'kind', type: 'enum', label: 'Kind' },
  { key: 'price', type: 'range', label: 'Price' },
  { key: 'size', type: 'enum' },
];

test('default export exposes createFilter and mount only', () => {
  assert.deepEqual(Object.keys(facetFilter).sort(), ['createFilter', 'mount']);
  assert.ok(Object.isFrozen(facetFilter));
});

test('createFilter returns a frozen filter with normalized facets', () => {
  const filter = createFilter(small, smallSchema);
  assert.ok(Object.isFrozen(filter));
  assert.equal(filter.size, 5);
  assert.deepEqual(filter.facets.map((f) => f.key), ['tags', 'kind', 'price', 'size']);
  assert.deepEqual(filter.facets[0].options.map((o) => o.value), ['big', 'blue', 'red']);
  assert.deepEqual(filter.facets[1].options.map((o) => o.value), ['book', 'tool', 'toy']);
  assert.deepEqual(filter.facets[3].options.map((o) => o.value), ['3', 'L']);
  assert.equal(filter.facets[3].label, 'size');
  assert.equal(filter.facets[2].min, 10);
  assert.equal(filter.facets[2].max, 40);
  assert.equal(filter.facets[2].step, 'any');
});

test('explicit options keep their order and labels', () => {
  const filter = createFilter(small, [
    { key: 'kind', type: 'enum', label: 'Kind', options: ['toy', { value: 'tool', label: 'Tools' }] },
  ]);
  assert.deepEqual(filter.facets[0].options, [{ value: 'toy', label: 'toy' }, { value: 'tool', label: 'Tools' }]);
});

test('empty state matches every item in input order', () => {
  const filter = createFilter(small, smallSchema);
  assert.deepEqual(filter.apply(filter.emptyState()), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(filter.apply({}), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(filter.apply(), ['a', 'b', 'c', 'd', 'e']);
  assert.ok(filter.isEmpty({}));
  assert.ok(!filter.isEmpty({ tags: ['red'] }));
});

test('tags facet requires every selected tag', () => {
  const filter = createFilter(small, smallSchema);
  assert.deepEqual(filter.apply({ tags: ['red'] }), ['a', 'c', 'e']);
  assert.deepEqual(filter.apply({ tags: ['red', 'big'] }), ['a', 'e']);
  assert.deepEqual(filter.apply({ tags: ['red', 'blue'] }), ['e']);
  assert.deepEqual(filter.apply({ tags: ['unknown'] }), []);
});

test('enum facet matches any selected value, comparing as strings', () => {
  const filter = createFilter(small, smallSchema);
  assert.deepEqual(filter.apply({ kind: ['toy'] }), ['b', 'e']);
  assert.deepEqual(filter.apply({ kind: ['toy', 'book'] }), ['b', 'd', 'e']);
  assert.deepEqual(filter.apply({ size: ['3'] }), ['c']);
});

test('range facet is inclusive and ignores non-numeric fields', () => {
  const filter = createFilter(small, smallSchema);
  assert.deepEqual(filter.apply({ price: { min: 10, max: 25 } }), ['a', 'b', 'e']);
  assert.deepEqual(filter.apply({ price: { min: 25, max: null } }), ['b', 'c']);
  assert.deepEqual(filter.apply({ price: { min: null, max: 10 } }), ['a', 'e']);
  assert.deepEqual(filter.apply({ price: { min: 30, max: 20 } }), []);
  assert.deepEqual(filter.apply({ price: { min: null, max: null } }), ['a', 'b', 'c', 'd', 'e']);
});

test('facets combine with AND', () => {
  const filter = createFilter(small, smallSchema);
  assert.deepEqual(filter.apply({ tags: ['red'], kind: ['tool'], price: { min: 20, max: null } }), ['c']);
});

test('stable order: results follow input order regardless of selection order', () => {
  const filter = createFilter(small, smallSchema);
  assert.deepEqual(filter.apply({ kind: ['toy', 'tool'] }), filter.apply({ kind: ['tool', 'toy'] }));
  assert.deepEqual(filter.apply({ tags: ['big', 'red'] }), filter.apply({ tags: ['red', 'big'] }));

  // Against the 250-item fixture, every result is a subsequence of input order.
  const big = createFilter(items, schema);
  const position = new Map(items.map((item, i) => [item.id, i]));
  for (const state of [{}, { tags: ['eco'] }, { category: ['Frostmere', 'Aetherworks'] }, { price: { min: 100, max: 300 } }]) {
    const ids = big.apply(state);
    for (let i = 1; i < ids.length; i++) assert.ok(position.get(ids[i - 1]) < position.get(ids[i]));
    assert.deepEqual(big.apply(state), ids, 'repeat calls are identical');
  }
});

test('stable order with many duplicate titles and values', () => {
  const dupes = Array.from({ length: 60 }, (_, i) => ({
    id: `x${i}`,
    title: 'Same',
    tags: ['t'],
    fields: { group: i % 3 === 0 ? 'g' : 'h', n: 5 },
  }));
  const filter = createFilter(dupes, [
    { key: 'group', type: 'enum', label: 'Group' },
    { key: 'n', type: 'range', label: 'N' },
  ]);
  const expected = dupes.filter((d) => d.fields.group === 'g').map((d) => d.id);
  assert.deepEqual(filter.apply({ group: ['g'], n: { min: 5, max: 5 } }), expected);
});

test('apply and normalize never mutate their input', () => {
  const filter = createFilter(small, smallSchema);
  const state = Object.freeze({ tags: Object.freeze(['red']), price: Object.freeze({ min: 1, max: null }) });
  filter.apply(state);
  const copy = filter.normalize(state);
  assert.notEqual(copy.tags, state.tags);
  copy.tags.push('blue');
  assert.deepEqual(state.tags, ['red']);
});

test('createFilter does not keep references to caller items', () => {
  const data = structuredClone(small);
  const filter = createFilter(data, smallSchema);
  data[0].tags.length = 0;
  data[0].fields.kind = 'changed';
  assert.deepEqual(filter.apply({ tags: ['big'] }), ['a', 'e']);
  assert.deepEqual(filter.apply({ kind: ['tool'] }), ['a', 'c']);
});

test('invalid items are rejected', () => {
  assert.throws(() => createFilter('nope', []), TypeError);
  assert.throws(() => createFilter([{ id: '', title: 't', tags: [], fields: {} }], []), /id/);
  assert.throws(() => createFilter([...small, small[0]], []), /duplicate item id "a"/);
  assert.throws(() => createFilter([{ id: 'x', title: 1, tags: [], fields: {} }], []), /title/);
  assert.throws(() => createFilter([{ id: 'x', title: 't', tags: [1], fields: {} }], []), /tags/);
  assert.throws(() => createFilter([{ id: 'x', title: 't', tags: [], fields: { n: NaN } }], []), /fields\.n/);
});

test('invalid schemas are rejected', () => {
  assert.throws(() => createFilter(small, {}), /schema must be an array/);
  assert.throws(() => createFilter(small, [{ key: 'k', type: 'slider' }]), /type/);
  assert.throws(() => createFilter(small, [{ key: '', type: 'enum' }]), /key/);
  assert.throws(() => createFilter(small, [{ key: 'k', type: 'enum' }, { key: 'k', type: 'tags' }]), /duplicate facet/);
  assert.throws(() => createFilter(small, [{ key: 'k', type: 'enum', options: ['a', 'a'] }]), /duplicate option/);
  assert.throws(() => createFilter(small, [{ key: 'k', type: 'range', options: { step: 0 } }]), /step/);
  assert.throws(() => createFilter(small, [{ key: 'k', type: 'range', options: { min: 'x' } }]), /min/);
});

test('invalid states are rejected', () => {
  const filter = createFilter(small, smallSchema);
  assert.throws(() => filter.apply({ nope: [] }), /unknown facet/);
  assert.throws(() => filter.apply({ tags: 'red' }), /array/);
  assert.throws(() => filter.apply({ tags: ['red', 'red'] }), /duplicate/);
  assert.throws(() => filter.apply({ tags: ['\uD800'] }), /well-formed/);
  assert.throws(() => filter.apply({ price: [1, 2] }), /min, max/);
  assert.throws(() => filter.apply({ price: { min: NaN, max: null } }), /finite/);
  assert.throws(() => filter.apply({ price: { min: 1, max: null, step: 2 } }), /unknown property/);
  assert.throws(() => filter.apply([]), /plain object/);
});

test('facet keys that collide with Object.prototype are safe', () => {
  // JSON.parse yields an own "__proto__" field, as real-world data would.
  const data = [
    { id: '1', title: 'a', tags: [], fields: JSON.parse('{"__proto__":"x","constructor":3}') },
    { id: '2', title: 'b', tags: [], fields: { constructor: 9 } },
  ];
  const filter = createFilter(data, [
    { key: '__proto__', type: 'enum', label: 'Proto' },
    { key: 'constructor', type: 'range', label: 'Ctor' },
  ]);
  assert.deepEqual(filter.apply({}), ['1', '2']);
  assert.deepEqual(filter.apply(JSON.parse('{"__proto__":["x"]}')), ['1']);
  assert.deepEqual(filter.apply({ constructor: { min: 5, max: null } }), ['2']);
  const empty = filter.emptyState();
  assert.ok(Object.prototype.hasOwnProperty.call(empty, '__proto__'));
  assert.equal(Object.getPrototypeOf(empty), Object.prototype);
});
