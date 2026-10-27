// facetFilter — dependency-free faceted filtering for plain ES2020 environments.
//
// Exports:
//   createFilter(items, schema) -> filter   pure, frozen filter object
//   mount(el, filter, options)  -> controller   accessible DOM controls
//
// State shape (one entry per facet key, in schema order):
//   tags  -> string[]                              item must carry every selected tag
//   enum  -> string[]                              item field must equal any selected value
//   range -> { min: number|null, max: number|null }  inclusive numeric bounds
//
// The module never touches the network, never writes globals, and only
// reaches the DOM through the element handed to mount().

const FACET_TYPES = ['tags', 'range', 'enum'];
const RANGE_SEPARATOR = '~';
const NUMBER_PATTERN = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

let mountCount = 0;

function fail(message) {
  throw new TypeError(`facetFilter: ${message}`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isWellFormedString(value) {
  return typeof value === 'string' && !LONE_SURROGATE.test(value);
}

// Code-unit ordering: identical in every engine, unlike localeCompare.
function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Defines an own enumerable property even for keys such as "__proto__".
function put(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  return target;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function validateItems(items) {
  if (!Array.isArray(items)) fail('items must be an array');
  const seen = new Set();
  items.forEach((item, index) => {
    const where = `items[${index}]`;
    if (!isPlainObject(item)) fail(`${where} must be an object`);
    if (typeof item.id !== 'string' || item.id === '') fail(`${where}.id must be a non-empty string`);
    if (seen.has(item.id)) fail(`duplicate item id "${item.id}"`);
    seen.add(item.id);
    if (typeof item.title !== 'string') fail(`${where}.title must be a string`);
    if (!Array.isArray(item.tags) || !item.tags.every((tag) => typeof tag === 'string')) {
      fail(`${where}.tags must be an array of strings`);
    }
    if (!isPlainObject(item.fields)) fail(`${where}.fields must be an object`);
    for (const [key, value] of Object.entries(item.fields)) {
      const ok = typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
      if (!ok) fail(`${where}.fields.${key} must be a string or finite number`);
    }
  });
}

function normalizeChoices(raw, key) {
  if (!Array.isArray(raw)) fail(`facet "${key}" options must be an array`);
  const seen = new Set();
  return raw.map((option) => {
    let choice;
    if (typeof option === 'string') {
      choice = { value: option, label: option };
    } else if (isPlainObject(option) && typeof option.value === 'string') {
      choice = { value: option.value, label: typeof option.label === 'string' ? option.label : option.value };
    } else {
      fail(`facet "${key}" options must be strings or { value, label } objects`);
    }
    if (!isWellFormedString(choice.value)) fail(`facet "${key}" option values must be well-formed strings`);
    if (seen.has(choice.value)) fail(`facet "${key}" has duplicate option "${choice.value}"`);
    seen.add(choice.value);
    return Object.freeze(choice);
  });
}

function deriveChoices(values) {
  return [...new Set(values)].sort(byCodeUnit).map((value) => Object.freeze({ value, label: value }));
}

function fieldValue(fields, key) {
  return hasOwn(fields, key) ? fields[key] : undefined;
}

function normalizeSchema(schema, items) {
  if (!Array.isArray(schema)) fail('schema must be an array');
  const keys = new Set();
  return schema.map((facet, index) => {
    if (!isPlainObject(facet)) fail(`schema[${index}] must be an object`);
    const { key, type } = facet;
    if (!isWellFormedString(key) || key === '') fail(`schema[${index}].key must be a non-empty string`);
    if (keys.has(key)) fail(`duplicate facet key "${key}"`);
    keys.add(key);
    if (!FACET_TYPES.includes(type)) fail(`facet "${key}" type must be one of ${FACET_TYPES.join(', ')}`);
    const label = facet.label === undefined ? key : facet.label;
    if (typeof label !== 'string') fail(`facet "${key}" label must be a string`);

    if (type === 'range') {
      const opts = facet.options === undefined ? {} : facet.options;
      if (!isPlainObject(opts)) fail(`facet "${key}" range options must be an object`);
      const numbers = items.map((item) => fieldValue(item.fields, key)).filter((v) => typeof v === 'number');
      const bound = (name, fallback) => {
        const value = opts[name];
        if (value === undefined) return fallback;
        if (typeof value !== 'number' || !Number.isFinite(value)) fail(`facet "${key}" options.${name} must be a finite number`);
        return value;
      };
      const step = opts.step === undefined ? 'any' : opts.step;
      if (step !== 'any' && !(typeof step === 'number' && step > 0 && Number.isFinite(step))) {
        fail(`facet "${key}" options.step must be a positive number or "any"`);
      }
      return Object.freeze({
        key,
        type,
        label,
        min: bound('min', numbers.length ? Math.min(...numbers) : null),
        max: bound('max', numbers.length ? Math.max(...numbers) : null),
        step,
      });
    }

    let choices;
    if (facet.options !== undefined) {
      choices = normalizeChoices(facet.options, key);
    } else if (type === 'tags') {
      choices = deriveChoices(items.flatMap((item) => item.tags));
    } else {
      const values = items.map((item) => fieldValue(item.fields, key)).filter((v) => v !== undefined);
      choices = deriveChoices(values.map(String));
    }
    return Object.freeze({ key, type, label, options: Object.freeze(choices) });
  });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function checkBound(value, where) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${where} must be a finite number or null`);
  return value;
}

// Validates a (possibly partial) state and returns a fresh, complete copy.
// Missing facets mean "no constraint"; unknown keys and malformed values throw.
function normalizeState(state, facets, byKey) {
  if (state === undefined || state === null) state = {};
  if (!isPlainObject(state)) fail('state must be a plain object');
  for (const key of Object.keys(state)) {
    if (!byKey.has(key)) fail(`state has unknown facet "${key}"`);
  }
  const out = {};
  for (const facet of facets) {
    const value = hasOwn(state, facet.key) ? state[facet.key] : undefined;
    if (facet.type === 'range') {
      if (value === undefined) {
        put(out, facet.key, { min: null, max: null });
        continue;
      }
      if (!isPlainObject(value)) fail(`state["${facet.key}"] must be { min, max }`);
      for (const k of Object.keys(value)) {
        if (k !== 'min' && k !== 'max') fail(`state["${facet.key}"] has unknown property "${k}"`);
      }
      put(out, facet.key, {
        min: checkBound(value.min, `state["${facet.key}"].min`),
        max: checkBound(value.max, `state["${facet.key}"].max`),
      });
      continue;
    }
    if (value === undefined) {
      put(out, facet.key, []);
      continue;
    }
    if (!Array.isArray(value)) fail(`state["${facet.key}"] must be an array of strings`);
    const seen = new Set();
    for (const entry of value) {
      if (!isWellFormedString(entry)) fail(`state["${facet.key}"] must contain well-formed strings`);
      if (seen.has(entry)) fail(`state["${facet.key}"] contains duplicate "${entry}"`);
      seen.add(entry);
    }
    put(out, facet.key, [...value]);
  }
  return out;
}

function emptyState(facets) {
  const out = {};
  for (const facet of facets) put(out, facet.key, facet.type === 'range' ? { min: null, max: null } : []);
  return out;
}

function isActive(facet, value) {
  return facet.type === 'range' ? value.min !== null || value.max !== null : value.length > 0;
}

function buildPredicate(facet, value) {
  const { key } = facet;
  if (facet.type === 'tags') {
    return (record) => value.every((tag) => record.tags.has(tag));
  }
  if (facet.type === 'enum') {
    const wanted = new Set(value);
    return (record) => {
      const field = record.fields[key];
      return field !== undefined && wanted.has(String(field));
    };
  }
  const { min, max } = value;
  return (record) => {
    const field = record.fields[key];
    return typeof field === 'number' && (min === null || field >= min) && (max === null || field <= max);
  };
}

// ---------------------------------------------------------------------------
// Query serialization
//
// Facets are written in schema order. List facets repeat their key once per
// value (`tags=a&tags=b`), preserving selection order. Range facets write a
// single `key=min~max` pair with either side optional; -0 is written as "-0"
// so it survives the trip. Inactive facets are omitted, so the empty state is "".
// ---------------------------------------------------------------------------

function numberToString(value) {
  if (value === null) return '';
  return Object.is(value, -0) ? '-0' : String(value);
}

function parseNumber(text) {
  if (text === '') return null;
  if (!NUMBER_PATTERN.test(text)) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

function decode(text) {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

function stateToQuery(state, facets) {
  const parts = [];
  for (const facet of facets) {
    const name = encodeURIComponent(facet.key);
    const value = state[facet.key];
    if (facet.type === 'range') {
      if (isActive(facet, value)) {
        parts.push(`${name}=${encodeURIComponent(numberToString(value.min) + RANGE_SEPARATOR + numberToString(value.max))}`);
      }
    } else {
      for (const entry of value) parts.push(`${name}=${encodeURIComponent(entry)}`);
    }
  }
  return parts.join('&');
}

// Lenient by design: unknown keys, malformed escapes and unparsable numbers
// are skipped rather than thrown, because query strings come from users.
function queryToState(query, facets, byKey) {
  if (typeof query !== 'string') fail('query must be a string');
  const body = query.startsWith('?') ? query.slice(1) : query;
  const out = emptyState(facets);
  const rangesSeen = new Set();
  for (const segment of body.split('&')) {
    if (segment === '') continue;
    const eq = segment.indexOf('=');
    const key = decode(eq === -1 ? segment : segment.slice(0, eq));
    const raw = decode(eq === -1 ? '' : segment.slice(eq + 1));
    if (key === null || raw === null || !byKey.has(key)) continue;
    const facet = byKey.get(key);
    if (facet.type === 'range') {
      if (rangesSeen.has(key)) continue;
      const sep = raw.indexOf(RANGE_SEPARATOR);
      if (sep === -1) continue;
      const min = parseNumber(raw.slice(0, sep));
      const max = parseNumber(raw.slice(sep + 1));
      if (min === undefined || max === undefined) continue;
      rangesSeen.add(key);
      out[key].min = min;
      out[key].max = max;
    } else if (!out[key].includes(raw)) {
      out[key].push(raw);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// createFilter
// ---------------------------------------------------------------------------

export function createFilter(items, schema) {
  validateItems(items);
  const facets = Object.freeze(normalizeSchema(schema, items));
  const byKey = new Map(facets.map((facet) => [facet.key, facet]));
  const records = items.map((item) => ({
    id: item.id,
    tags: new Set(item.tags),
    fields: Object.assign(Object.create(null), item.fields),
  }));
  const normalize = (state) => normalizeState(state, facets, byKey);

  return Object.freeze({
    facets,
    size: records.length,
    emptyState: () => emptyState(facets),
    normalize,
    isEmpty(state) {
      const full = normalize(state);
      return facets.every((facet) => !isActive(facet, full[facet.key]));
    },
    // Matching ids in the original input order. Selection order in the state
    // never affects the result.
    apply(state) {
      const full = normalize(state);
      const predicates = facets
        .filter((facet) => isActive(facet, full[facet.key]))
        .map((facet) => buildPredicate(facet, full[facet.key]));
      const ids = [];
      for (const record of records) {
        if (predicates.every((matches) => matches(record))) ids.push(record.id);
      }
      return ids;
    },
    toQuery: (state) => stateToQuery(normalize(state), facets),
    fromQuery: (query) => queryToState(query, facets, byKey),
  });
}

// ---------------------------------------------------------------------------
// mount
// ---------------------------------------------------------------------------

function defaultStatus(count, total) {
  if (count === 0) return `No results (0 of ${total})`;
  return `${count} ${count === 1 ? 'result' : 'results'} of ${total}`;
}

export function mount(el, filter, options = {}) {
  if (!el || el.nodeType !== 1) fail('mount target must be a DOM element');
  if (!filter || typeof filter.apply !== 'function' || !Array.isArray(filter.facets)) {
    fail('mount requires a filter from createFilter()');
  }
  if (!isPlainObject(options)) fail('mount options must be an object');
  const { onChange, formatStatus = defaultStatus, label = 'Filters' } = options;
  if (onChange !== undefined && typeof onChange !== 'function') fail('onChange must be a function');
  if (typeof formatStatus !== 'function') fail('formatStatus must be a function');

  const doc = el.ownerDocument;
  const uid = `ff${++mountCount}`;
  const meta = new WeakMap();
  const views = [];
  let state = typeof options.state === 'string' ? filter.fromQuery(options.state) : filter.normalize(options.state);
  let ids = [];

  function h(tag, attrs = {}, ...children) {
    const node = doc.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (value === false || value === undefined || value === null) continue;
      node.setAttribute(name, value === true ? '' : String(value));
    }
    for (const child of children) node.append(child);
    return node;
  }

  const root = h('form', { class: 'ff', role: 'search', 'aria-label': label, novalidate: true });

  filter.facets.forEach((facet, facetIndex) => {
    const base = `${uid}-${facetIndex}`;
    const fieldset = h('fieldset', { class: `ff-facet ff-facet--${facet.type}` });
    fieldset.append(h('legend', { class: 'ff-legend', id: `${base}-legend` }, facet.label));

    if (facet.type === 'tags') {
      const bar = h('div', { class: 'ff-chips', role: 'toolbar', 'aria-labelledby': `${base}-legend` });
      const chips = facet.options.map((choice, i) => {
        const chip = h(
          'button',
          { type: 'button', class: 'ff-chip', 'aria-pressed': 'false', tabindex: i === 0 ? '0' : '-1' },
          choice.label,
        );
        meta.set(chip, { kind: 'chip', facet, value: choice.value });
        bar.append(chip);
        return chip;
      });
      if (chips.length === 0) bar.append(h('p', { class: 'ff-none' }, 'No options'));
      fieldset.append(bar);
      views.push({ facet, chips });
    } else if (facet.type === 'enum') {
      const list = h('ul', { class: 'ff-options', role: 'list' });
      const boxes = facet.options.map((choice, i) => {
        const id = `${base}-${i}`;
        const box = h('input', { type: 'checkbox', class: 'ff-check', id });
        meta.set(box, { kind: 'check', facet, value: choice.value });
        list.append(h('li', { class: 'ff-option' }, box, h('label', { for: id }, choice.label)));
        return box;
      });
      fieldset.append(boxes.length ? list : h('p', { class: 'ff-none' }, 'No options'));
      views.push({ facet, boxes });
    } else {
      const hasBounds = facet.min !== null && facet.max !== null;
      const hintId = `${base}-hint`;
      const input = (bound) => {
        const id = `${base}-${bound}`;
        const field = h('input', {
          type: 'number',
          class: 'ff-number',
          id,
          inputmode: 'decimal',
          step: facet.step,
          placeholder: facet[bound] === null ? undefined : numberToString(facet[bound]),
          'aria-describedby': hasBounds ? hintId : undefined,
        });
        meta.set(field, { kind: 'number', facet, bound });
        return { field, wrap: h('div', { class: 'ff-bound' }, h('label', { for: id }, bound === 'min' ? 'Minimum' : 'Maximum'), field) };
      };
      const min = input('min');
      const max = input('max');
      fieldset.append(h('div', { class: 'ff-range' }, min.wrap, max.wrap));
      if (hasBounds) {
        fieldset.append(h('p', { class: 'ff-hint', id: hintId }, `Available: ${numberToString(facet.min)} to ${numberToString(facet.max)}`));
      }
      views.push({ facet, min: min.field, max: max.field });
    }
    root.append(fieldset);
  });

  const status = h('p', { class: 'ff-status', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const clearButton = h('button', { type: 'button', class: 'ff-clear' }, 'Clear all filters');
  meta.set(clearButton, { kind: 'clear' });
  root.append(h('div', { class: 'ff-toolbar' }, status, clearButton));

  const emptyClear = h('button', { type: 'button', class: 'ff-empty-clear' }, 'Clear all filters');
  meta.set(emptyClear, { kind: 'clear' });
  const emptyPanel = h(
    'div',
    { class: 'ff-empty', hidden: true },
    h('p', { class: 'ff-empty-title' }, 'No items match these filters.'),
    h('p', { class: 'ff-empty-hint' }, 'Remove a filter, or clear them all to start over.'),
    emptyClear,
  );
  root.append(emptyPanel);

  function render(skip) {
    for (const view of views) {
      const value = state[view.facet.key];
      if (view.chips) {
        view.chips.forEach((chip) => chip.setAttribute('aria-pressed', String(value.includes(meta.get(chip).value))));
      } else if (view.boxes) {
        view.boxes.forEach((box) => { box.checked = value.includes(meta.get(box).value); });
      } else {
        for (const bound of ['min', 'max']) {
          if (view[bound] !== skip) view[bound].value = numberToString(value[bound]);
        }
      }
    }
    ids = filter.apply(state);
    const text = formatStatus(ids.length, filter.size);
    if (status.textContent !== text) status.textContent = text;
    emptyPanel.hidden = ids.length > 0;
    root.classList.toggle('ff--empty', ids.length === 0);
  }

  function snapshot(source) {
    return { state: filter.normalize(state), ids: [...ids], query: filter.toQuery(state), source };
  }

  function commit(next, source, skip) {
    state = filter.normalize(next);
    render(skip);
    if (onChange) onChange(snapshot(source));
  }

  function withValue(next, key, value) {
    put(next, key, value);
    return next;
  }

  function toggle(key, value) {
    const current = state[key];
    const updated = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    return withValue(filter.normalize(state), key, updated);
  }

  function firstControl() {
    return root.querySelector('.ff-chip[tabindex="0"], .ff-check, .ff-number');
  }

  function onClick(event) {
    const button = event.target.closest ? event.target.closest('button') : null;
    const info = button && meta.get(button);
    if (!info) return;
    if (info.kind === 'chip') {
      setRoving(button);
      commit(toggle(info.facet.key, info.value), 'user');
    } else if (info.kind === 'clear') {
      const fromPanel = button === emptyClear;
      commit(filter.emptyState(), 'user');
      // The panel hides itself on clear; keep focus somewhere useful.
      if (fromPanel || doc.activeElement === doc.body) {
        const target = firstControl() || clearButton;
        target.focus();
      }
    }
  }

  function onChangeEvent(event) {
    const info = meta.get(event.target);
    if (info && info.kind === 'check') commit(toggle(info.facet.key, info.value), 'user');
  }

  function onInput(event) {
    const info = meta.get(event.target);
    if (!info || info.kind !== 'number') return;
    const text = event.target.value.trim();
    const parsed = text === '' ? null : Number(text);
    const value = parsed === null || Number.isFinite(parsed) ? parsed : null;
    const range = { ...state[info.facet.key], [info.bound]: value };
    commit(withValue(filter.normalize(state), info.facet.key, range), 'user', event.target);
  }

  function setRoving(chip) {
    const bar = chip.parentNode;
    for (const other of bar.querySelectorAll('.ff-chip')) other.setAttribute('tabindex', other === chip ? '0' : '-1');
  }

  function onKeydown(event) {
    const info = meta.get(event.target);
    if (!info || info.kind !== 'chip') return;
    const chips = [...event.target.parentNode.querySelectorAll('.ff-chip')];
    const index = chips.indexOf(event.target);
    const last = chips.length - 1;
    const moves = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowDown: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      ArrowUp: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    if (!hasOwn(moves, event.key)) return;
    event.preventDefault();
    const next = chips[moves[event.key]];
    setRoving(next);
    next.focus();
  }

  function onSubmit(event) {
    event.preventDefault();
  }

  root.addEventListener('click', onClick);
  root.addEventListener('change', onChangeEvent);
  root.addEventListener('input', onInput);
  root.addEventListener('keydown', onKeydown);
  root.addEventListener('submit', onSubmit);
  el.append(root);
  render();
  if (onChange) onChange(snapshot('init'));

  return Object.freeze({
    element: root,
    getState: () => filter.normalize(state),
    getIds: () => [...ids],
    setState: (next) => commit(typeof next === 'string' ? filter.fromQuery(next) : next, 'api'),
    clear: () => commit(filter.emptyState(), 'api'),
    destroy() {
      root.removeEventListener('click', onClick);
      root.removeEventListener('change', onChangeEvent);
      root.removeEventListener('input', onInput);
      root.removeEventListener('keydown', onKeydown);
      root.removeEventListener('submit', onSubmit);
      root.remove();
    },
  });
}

const facetFilter = Object.freeze({ createFilter, mount });
export default facetFilter;
