A dependency-free browser filtering utility with deterministic state, accessible controls, query serialization, and a small demonstration page.

# facet-filter-kit

`src/facetFilter.js` is a plain ES2020 module with no dependencies and no build step. `styles/facet-filter.css` is the matching stylesheet. The module makes no network calls, collects no analytics and adds no globals.

```js
import { createFilter, mount } from './src/facetFilter.js';

const filter = createFilter(items, [
  { key: 'category', type: 'enum', label: 'Category' },
  { key: 'tags', type: 'tags', label: 'Tags' },
  { key: 'price', type: 'range', label: 'Price', options: { step: 0.01 } },
]);

filter.apply({ tags: ['eco'], price: { min: 10, max: null } }); // -> ['item-004', ...]
const query = filter.toQuery(state);                            // 'tags=eco&price=10~'
filter.fromQuery(query);                                        // deep-equals state

const ui = mount(document.getElementById('filters'), filter, {
  state: location.search,            // an object or a query string
  onChange({ state, ids, query, source }) { /* source: 'init' | 'user' | 'api' */ },
});
```

## Data

- **Items:** `{ id: string, title: string, tags: string[], fields: Record<string, number|string> }`. Ids must be unique. Bad input throws a `TypeError` that names the problem.
- **Schema:** `[{ key, type, label?, options? }]`.
  - `tags`: matches `item.tags`. An item must have **every** selected tag. Options default to all tags found in the items.
  - `enum`: matches `item.fields[key]`, compared as strings. An item may match **any** selected value. Options default to the distinct values found.
  - `range`: matches numeric `item.fields[key]` within inclusive bounds. Non-numeric values never match an active range. `options` is `{ min?, max?, step? }`; `min` and `max` default to the data's extent.
  - `options` for `tags` and `enum` may be strings or `{ value, label }` objects. They keep the order you give them.

## State

A state holds one entry per facet. `tags` and `enum` facets take an array of distinct strings, and a `range` facet takes `{ min: number|null, max: number|null }`. Facets combine with AND.

- `apply()` and `toQuery()` accept partial states: a missing facet means "no constraint". Unknown keys and malformed values throw.
- `filter.emptyState()` and `filter.normalize(state)` return complete states.
- `apply(state)` returns matching ids in input order. Neither selection order nor repeated calls change that order.

## Query strings

Facets are written in schema order:

- A list facet repeats its key, once per value, in selection order (`tags=eco&tags=gift`).
- A range is written as `key=min~max`, with either side optional (`price=10~`).
- Inactive facets are left out, so the empty state is `''`.
- Values are percent-encoded, and `-0` is kept.

For every valid complete state, `fromQuery(toQuery(state))` deep-equals the state, and the reverse direction is canonical too. `fromQuery` accepts a leading `?`, and it skips unknown keys, malformed escapes and unparsable numbers instead of throwing.

## Controls

`mount(el, filter, { onChange, state, label, formatStatus })` renders a `<form role="search">` with one `<fieldset>`/`<legend>` per facet:

- **tags:** `aria-pressed` toggle buttons in a `role="toolbar"`. Arrow keys, Home and End move a roving tabindex, and Enter or Space toggles.
- **enum:** native, labelled checkbox groups. Their checked state is exposed natively, so no `aria-checked` is added to native inputs.
- **range:** labelled Minimum/Maximum number inputs, with an "Available: x to y" hint.
- **Result count:** a polite, atomic `role="status"` live region, plus a "Clear all filters" button.
- **No results:** a panel with its own "Clear all filters" button. After clearing, focus moves to the first control.

All controls are native buttons or inputs, focus is always visible (`:focus-visible`), and labels are set as text, never as HTML.

`mount` returns `{ element, getState, getIds, setState, clear, destroy }`.

## Development

```sh
npm install       # dev-only: jsdom for the DOM tests
npm test          # node --test test/*.test.js
npm run fixture   # regenerate fixtures/items.js (seeded, deterministic)
```

The tests cover:

- seeded property-based URL round-trips (3 seeds × 2000 states × 2 schemas, including awkward keys, Unicode and extreme doubles)
- `apply` semantics and stable ordering
- input validation
- jsdom tests for structure, ARIA state, keyboard navigation, the live region and the empty-result panel
- a check that the committed fixture matches its generator
- a static scan ruling out network, storage and global access

### Demo

ES modules don't load from `file://`, so serve the repository root over HTTP and open `/demo/index.html`, for example:

```sh
python3 -m http.server 8000   # then visit http://localhost:8000/demo/index.html
```

The demo loads the 250-item fixture (six fictional categories) and keeps the URL query in sync with the filters.
