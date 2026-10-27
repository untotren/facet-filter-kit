import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createFilter, mount } from '../src/facetFilter.js';
import items from '../fixtures/items.js';
import schema from '../fixtures/schema.js';

function setup(options = {}, data = items, facets = schema) {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>');
  const { document } = dom.window;
  const host = document.getElementById('app');
  const filter = createFilter(data, facets);
  const events = [];
  const controller = mount(host, filter, { onChange: (detail) => events.push(detail), ...options });
  const $ = (selector) => host.querySelector(selector);
  const $$ = (selector) => [...host.querySelectorAll(selector)];
  const key = (target, name) => {
    const event = new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  const type = (input, value) => {
    input.value = value;
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  return { dom, document, host, filter, controller, events, $, $$, key, type };
}

function facetFieldset($$, legend) {
  return $$('fieldset').find((fs) => fs.querySelector('legend').textContent === legend);
}

// Elements reachable with Tab, in DOM order (jsdom has no layout, so this
// mirrors the browser's sequential focus navigation for tabindex <= 0).
function tabOrder(root) {
  return [...root.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')].filter(
    (el) => !el.disabled && el.tabIndex >= 0 && !el.closest('[hidden]'),
  );
}

test('renders one fieldset with a legend per facet', () => {
  const { $$ } = setup();
  const fieldsets = $$('fieldset');
  assert.equal(fieldsets.length, schema.length);
  assert.deepEqual(fieldsets.map((fs) => fs.querySelector('legend').textContent), schema.map((f) => f.label));
  assert.ok(fieldsets.every((fs) => fs.firstElementChild.tagName === 'LEGEND'));
});

test('form is a labelled search landmark that never submits', () => {
  const { $, dom } = setup();
  const form = $('form');
  assert.equal(form.getAttribute('role'), 'search');
  assert.equal(form.getAttribute('aria-label'), 'Filters');
  const submit = new dom.window.Event('submit', { cancelable: true });
  form.dispatchEvent(submit);
  assert.ok(submit.defaultPrevented);
});

test('enum facets render labelled checkbox groups', () => {
  const { $$, document } = setup();
  const category = facetFieldset($$, 'Category');
  const boxes = [...category.querySelectorAll('input[type="checkbox"]')];
  assert.equal(boxes.length, 6);
  for (const box of boxes) {
    const label = document.querySelector(`label[for="${box.id}"]`);
    assert.ok(label && label.textContent.length > 0, 'every checkbox has a label');
  }
  const ids = $$('[id]').map((el) => el.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
});

test('tags facet renders aria-pressed toggle buttons in a toolbar', () => {
  const { $$ } = setup();
  const tags = facetFieldset($$, 'Tags');
  const bar = tags.querySelector('[role="toolbar"]');
  assert.equal(bar.getAttribute('aria-labelledby'), tags.querySelector('legend').id);
  const chips = [...bar.querySelectorAll('button')];
  assert.equal(chips.length, 12);
  assert.ok(chips.every((c) => c.getAttribute('type') === 'button' && c.getAttribute('aria-pressed') === 'false'));
});

test('range facets render labelled min/max number inputs', () => {
  const { $$, document } = setup();
  const price = facetFieldset($$, 'Price (credits)');
  const inputs = [...price.querySelectorAll('input[type="number"]')];
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs.map((i) => document.querySelector(`label[for="${i.id}"]`).textContent), ['Minimum', 'Maximum']);
  assert.equal(inputs[0].getAttribute('step'), '0.01');
  const hint = document.getElementById(inputs[0].getAttribute('aria-describedby'));
  assert.match(hint.textContent, /^Available: [\d.]+ to [\d.]+$/);
});

test('live region announces the result count', () => {
  const { $, events } = setup();
  const status = $('[role="status"]');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(status.getAttribute('aria-atomic'), 'true');
  assert.equal(status.textContent, '250 results of 250');
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'init');
  assert.equal(events[0].ids.length, 250);
});

test('toggling a chip updates aria-pressed, results and onChange', () => {
  const { $$, $, events, filter } = setup();
  const chip = facetFieldset($$, 'Tags').querySelector('button');
  chip.click();
  assert.equal(chip.getAttribute('aria-pressed'), 'true');
  const last = events.at(-1);
  assert.equal(last.source, 'user');
  assert.deepEqual(last.state.tags, ['bestseller']);
  assert.deepEqual(last.ids, filter.apply({ tags: ['bestseller'] }));
  assert.equal(last.query, 'tags=bestseller');
  assert.equal($('[role="status"]').textContent, `${last.ids.length} results of 250`);
  chip.click();
  assert.equal(chip.getAttribute('aria-pressed'), 'false');
  assert.equal(events.at(-1).ids.length, 250);
});

test('checking a checkbox filters by that value', () => {
  const { $$, events, filter } = setup();
  const box = facetFieldset($$, 'Category').querySelector('input');
  box.click();
  assert.ok(box.checked);
  assert.deepEqual(events.at(-1).state.category, ['Aetherworks']);
  assert.deepEqual(events.at(-1).ids, filter.apply({ category: ['Aetherworks'] }));
});

test('typing in range inputs filters without overwriting what the user typed', () => {
  const { $$, events, type, filter } = setup();
  const [min, max] = facetFieldset($$, 'Price (credits)').querySelectorAll('input');
  type(min, '100');
  type(max, '200.5');
  assert.deepEqual(events.at(-1).state.price, { min: 100, max: 200.5 });
  assert.deepEqual(events.at(-1).ids, filter.apply({ price: { min: 100, max: 200.5 } }));
  type(max, '');
  assert.deepEqual(events.at(-1).state.price, { min: 100, max: null });
  assert.equal(min.value, '100');
});

test('keyboard: arrow keys, Home and End move a roving focus across chips', () => {
  const { $$, key, document } = setup();
  const chips = [...facetFieldset($$, 'Tags').querySelectorAll('button')];
  const tabbable = () => chips.filter((c) => c.tabIndex === 0);
  assert.deepEqual(tabbable(), [chips[0]], 'exactly one chip is in the tab order');

  chips[0].focus();
  assert.ok(key(chips[0], 'ArrowRight').defaultPrevented);
  assert.equal(document.activeElement, chips[1]);
  assert.deepEqual(tabbable(), [chips[1]]);
  key(chips[1], 'ArrowDown');
  assert.equal(document.activeElement, chips[2]);
  key(chips[2], 'End');
  assert.equal(document.activeElement, chips.at(-1));
  key(chips.at(-1), 'ArrowRight');
  assert.equal(document.activeElement, chips[0], 'wraps forward');
  key(chips[0], 'ArrowLeft');
  assert.equal(document.activeElement, chips.at(-1), 'wraps backward');
  key(chips.at(-1), 'Home');
  assert.equal(document.activeElement, chips[0]);
  key(chips[0], 'ArrowUp');
  assert.equal(document.activeElement, chips.at(-1));
  assert.ok(!key(chips.at(-1), 'a').defaultPrevented, 'other keys are left alone');
});

test('keyboard: every facet is reachable with Tab and every control is a native focusable element', () => {
  const { $, $$ } = setup();
  const order = tabOrder($('form'));
  for (const fieldset of $$('fieldset')) {
    assert.ok(order.some((el) => fieldset.contains(el)), `${fieldset.querySelector('legend').textContent} is reachable`);
  }
  assert.ok(order.every((el) => ['BUTTON', 'INPUT'].includes(el.tagName)));
  assert.ok(order.includes($('.ff-clear')));
  assert.ok(!order.includes($('.ff-empty-clear')), 'hidden panel is skipped');
  // Chips toggle via native button activation (Enter/Space dispatch click).
  const chip = order.find((el) => el.classList.contains('ff-chip'));
  chip.focus();
  chip.click();
  assert.equal(chip.getAttribute('aria-pressed'), 'true');
});

test('empty results show the no-results panel with a working clear-all control', () => {
  const { $, $$, type, events, document } = setup();
  const panel = $('.ff-empty');
  assert.ok(panel.hidden);
  const [min] = facetFieldset($$, 'Year').querySelectorAll('input');
  type(min, '3000');
  facetFieldset($$, 'Tags').querySelector('button').click();

  assert.equal(events.at(-1).ids.length, 0);
  assert.equal(panel.hidden, false);
  assert.ok($('form').classList.contains('ff--empty'));
  assert.equal($('[role="status"]').textContent, 'No results (0 of 250)');
  const clear = panel.querySelector('button');
  assert.equal(clear.textContent, 'Clear all filters');
  assert.ok(tabOrder($('form')).includes(clear), 'clear-all is keyboard reachable');

  clear.focus();
  clear.click();
  assert.ok(panel.hidden);
  assert.equal(min.value, '');
  assert.ok($$('.ff-chip').every((c) => c.getAttribute('aria-pressed') === 'false'));
  assert.equal(events.at(-1).ids.length, 250);
  assert.equal(events.at(-1).query, '');
  assert.equal($('[role="status"]').textContent, '250 results of 250');
  assert.equal(document.activeElement, tabOrder($('form'))[0], 'focus moves to the first control');
  assert.equal(document.activeElement, $('.ff-check'));
});

test('initial state may be an object or a query string and is reflected in the controls', () => {
  const { $$, controller } = setup({ state: 'category=Brinecraft&tags=eco&price=10~' });
  assert.ok(facetFieldset($$, 'Category').querySelectorAll('input')[1].checked);
  const eco = facetFieldset($$, 'Tags').querySelectorAll('button')[3];
  assert.equal(eco.textContent, 'eco');
  assert.equal(eco.getAttribute('aria-pressed'), 'true');
  assert.equal(facetFieldset($$, 'Price (credits)').querySelector('input').value, '10');
  assert.deepEqual(controller.getState().tags, ['eco']);
});

test('setState and clear update controls and report source "api"', () => {
  const { $$, controller, events } = setup();
  controller.setState({ region: ['Westvale'], rating: { min: 4.5, max: null } });
  assert.equal(events.at(-1).source, 'api');
  const rating = facetFieldset($$, 'Rating').querySelector('input');
  assert.equal(rating.value, '4.5');
  assert.deepEqual(controller.getIds(), events.at(-1).ids);
  controller.clear();
  assert.equal(rating.value, '');
  assert.equal(controller.getIds().length, 250);
});

test('labels are rendered as text, never as markup', () => {
  const data = [{ id: '1', title: 't', tags: ['<img src=x onerror=alert(1)>'], fields: {} }];
  const { $, $$ } = setup({}, data, [{ key: 'tags', type: 'tags', label: '<b>Tags</b>' }]);
  assert.equal($$('img').length, 0);
  assert.equal($$('b').length, 0);
  assert.equal($('legend').textContent, '<b>Tags</b>');
  assert.equal($('.ff-chip').textContent, '<img src=x onerror=alert(1)>');
});

test('facets with no options render a placeholder and stay valid', () => {
  const { $$ } = setup({}, [], [{ key: 'tags', type: 'tags', label: 'Tags' }, { key: 'k', type: 'enum', label: 'K' }]);
  assert.deepEqual($$('.ff-none').map((p) => p.textContent), ['No options', 'No options']);
});

test('destroy removes the controls and stops reporting changes', () => {
  const { host, controller, events, $ } = setup();
  const chip = $('.ff-chip');
  controller.destroy();
  assert.equal(host.children.length, 0);
  chip.click();
  assert.equal(events.length, 1);
});

test('two mounts on one page get distinct ids', () => {
  const dom = new JSDOM('<!doctype html><div id="a"></div><div id="b"></div>');
  const { document } = dom.window;
  const filter = createFilter(items, schema);
  mount(document.getElementById('a'), filter);
  mount(document.getElementById('b'), filter);
  const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('mount validates its arguments', () => {
  const dom = new JSDOM('<div id="a"></div>');
  const el = dom.window.document.getElementById('a');
  const filter = createFilter(items, schema);
  assert.throws(() => mount(null, filter), /DOM element/);
  assert.throws(() => mount(el, {}), /createFilter/);
  assert.throws(() => mount(el, filter, { onChange: 1 }), /onChange/);
});
