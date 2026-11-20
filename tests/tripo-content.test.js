import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const dashboard = await readFile(new URL('../dashboard.js', import.meta.url), 'utf8');

const element = (tag, children = [], attrs = {}, style = {}) => {
  const node = {
    nodeType: 1, tagName: tag.toUpperCase(), attrs, style, childNodes: [], parentElement: null, isConnected: true, clicks: 0,
    getAttribute: name => attrs[name] ?? null,
    getClientRects: () => style.display === 'none' ? [] : [1],
    classList: { contains: name => (attrs.class || '').split(/\s+/).includes(name) },
    contains(other) { return this === other || this.children.some(child => child.contains(other)); },
    matches(selector) {
      return selector.split(',').some(part => {
        part = part.trim();
        if (part === 'button' || part === 'span' || part === 'p' || part === 'small' || part === 'div' || part === 'img') return this.tagName.toLowerCase() === part;
        if (part === 'input[type="file"]') return this.tagName === 'INPUT' && attrs.type === 'file';
        if (part === 'button[aria-label="Upgrade" i]') return this.tagName === 'BUTTON' && attrs['aria-label'] === 'Upgrade';
        const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
        return !!attribute && attrs[attribute[1]] !== undefined && (attribute[2] === undefined || attrs[attribute[1]] === attribute[2]);
      });
    },
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; },
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
    click() { this.clicks++; this.disabled = true; },
    dispatchEvent() {}
  };
  for (const child of children) {
    const entry = typeof child === 'string' ? { nodeType: 3, textContent: child } : child;
    entry.parentElement = node;
    node.childNodes.push(entry);
  }
  Object.defineProperties(node, {
    children: { get: () => node.childNodes.filter(child => child.nodeType === 1) },
    textContent: { get: () => node.childNodes.map(child => child.textContent).join('') },
    innerText: { get: () => node.textContent }
  });
  return node;
};
const price = (value, attrs = {}, style = {}) => element('span', [value], attrs, style);
const fixture = (prices, balance = '13404') => {
  let now = 0;
  let listener;
  const button = element('button', ['Generate', ...prices]);
  const input = element('input', [], { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
  const panel = element('div', [input, element('div', [button], { class: 'p-3 w-full relative' })], { class: 'flex flex-col size-full box-border' });
  const modelInput = element('input', [], { type: 'file', accept: '.obj,.fbx,.glb' });
  const header = element('div', [element('p', [balance], { title: balance }), element('button', ['Upgrade'], { 'aria-label': 'Upgrade' })]);
  const unrelated = element('button', ['Generate Image for 3D']);
  const body = element('body', [header, modelInput, unrelated, panel]);
  const context = vm.createContext({
    document: { body, querySelectorAll: selector => body.querySelectorAll(selector) },
    location: { protocol: 'https:', hostname: 'studio.tripo3d.ai', pathname: '/workspace/generate', href: 'https://studio.tripo3d.ai/workspace/generate', origin: 'https://studio.tripo3d.ai' },
    chrome: { runtime: { id: 'extension', onMessage: { addListener: value => { listener = value; } } } },
    window: { addEventListener() {} }, URL, Date: { now: () => now },
    setTimeout: callback => { now += 500; callback(); }, clearTimeout() {},
    getComputedStyle: node => ({ display: 'block', visibility: 'visible', textDecorationLine: 'none', ...node.style })
  });
  vm.runInContext(source.replace(/\}\)\(\);\s*$/, 'globalThis.fixture = { generateButton, currentCost, currentBalance, panelFor, imageInput, confirm: file => { uploaded = { panel: panelFor(imageInput()), file, sourceMarkers: [] }; } }; })();'), context);
  const request = message => new Promise(resolve => listener(message, { id: 'extension' }, resolve)).then(async result => { await Promise.resolve(); return result; });
  return { api: context.fixture, request, button, input, panel, unrelated, confirm: () => {
    const file = { name: 'bird.png', size: 10, lastModified: 1 };
    input.files = [file]; context.fixture.confirm(file);
  } };
};

test('discounted live markup identifies Generate, the image input and its containing panel', async () => {
  const page = fixture([price('65', { class: 'opacity-50 line-through' }, { textDecorationLine: 'line-through' }), price('0')]);
  assert.equal(page.api.generateButton(), page.button);
  assert.equal(page.api.imageInput(), page.input);
  assert.equal(page.api.panelFor(page.input), page.panel);
  const info = await page.request({ type: 'tripo:inspect' });
  assert.equal(info.cost, 0);
  assert.equal(info.balance, 13404);
  assert.equal(info.uploadReady, true);
  assert.equal(page.button.clicks, 0);
  assert.equal(page.unrelated.clicks, 0);
});

test('ordinary and grouped integer prices retain the actual charge', () => {
  assert.equal(fixture([price('55')]).api.currentCost(), 55);
  assert.equal(fixture([price('65')]).api.currentCost(), 65);
  assert.equal(fixture([price('1,250')]).api.currentCost(), 1250);
});

test('old prices are excluded for semantic tags, classes and computed styles', () => {
  const old = [element('s', ['65']), element('del', ['65']), element('strike', ['65']), price('65', { class: 'line-through' }), price('65', {}, { textDecorationLine: 'line-through' })];
  for (const crossed of old) assert.equal(fixture([crossed, price('0')]).api.currentCost(), 0);
});

test('hidden old labels are ignored; missing, ambiguous or malformed effective costs fail closed', () => {
  assert.equal(fixture([price('65', {}, { display: 'none' }), price('0')]).api.currentCost(), 0);
  assert.equal(fixture([price('65', { 'aria-hidden': 'true' }), price('0')]).api.currentCost(), 0);
  for (const prices of [[], [price('65'), price('0')], [price('65', { class: 'line-through' })], [price('55', {}, { display: 'none' })], [price('1,2')], [price('5.5')], [price('-1')], [price('unknown')]]) {
    assert.equal(fixture(prices).api.currentCost(), null);
  }
});

test('paid price above the ceiling and unknown price never click Generate', async () => {
  for (const [prices, code] of [[[price('65')], 'COST_LIMIT'], [[price('65'), price('0')], 'COST_UNKNOWN'], [[], 'COST_UNKNOWN']]) {
    const page = fixture(prices); page.confirm();
    const result = await page.request({ type: 'tripo:generate', jobId: 'bird', maxCredits: 55 });
    assert.equal(result.code, code);
    assert.equal(result.submitted, false);
    assert.equal(page.button.clicks, 0);
  }
});

test('free generation is valid with zero balance and cannot be submitted twice', async () => {
  const page = fixture([price('65', { class: 'line-through' }), price('0')], '0'); page.confirm();
  const result = await page.request({ type: 'tripo:generate', jobId: 'bird', maxCredits: 55 });
  assert.equal(result.ok, true);
  assert.equal(result.cost, 0);
  assert.equal(result.submitted, true);
  assert.equal(page.button.clicks, 1);
  assert.equal((await page.request({ type: 'tripo:generate', jobId: 'bird', maxCredits: 55 })).code, 'ALREADY_SUBMITTED');
  assert.equal(page.button.clicks, 1);
});

const dashboardFunction = (name, next, context) => {
  const start = dashboard.indexOf(`const ${name} =`);
  const end = dashboard.indexOf(`\n${next}`, start);
  return vm.runInNewContext(`${dashboard.slice(start, end)}\n${name}`, context);
};
test('dashboard accepts zero cost but blocks unavailable, negative and excessive prices before submission', async () => {
  for (const [cost, expected] of [[0, 'SUBMISSION_REACHED'], [55, 'INSUFFICIENT_CREDITS'], [65, 'COST_LIMIT'], [null, 'COST_UNKNOWN'], [NaN, 'COST_UNKNOWN'], [-1, 'COST_UNKNOWN']]) {
    const state = { root: {}, current: { id: 'bird', sourceName: 'bird.png', sourceHash: 'hash' }, options: { maxCredits: 55 } };
    const generationStep = dashboardFunction('generationStep', 'const waitForModel', {
      state, readSource: async () => ({ name: 'bird.png' }), sha256: async () => 'hash', setStatus() {},
      ensureStudio: async () => ({ cost, balance: 0, baseline: { assetIds: [] }, url: 'https://studio.tripo3d.ai/workspace/generate' }),
      studioMessage: async () => ({}), sourceMime: () => 'image/png', base64File: async () => '', UPLOAD_TIMEOUT: 75000, showStudio() {}, URL,
      errorWith: (message, code) => Object.assign(new Error(message), { code }),
      saveJob: async change => { if (change.status === 'submitting') throw Object.assign(new Error('Submission reached'), { code: 'SUBMISSION_REACHED' }); }
    });
    await assert.rejects(generationStep(), error => error.code === expected);
  }
});

test('recovery shows the saved failure and resume instructions without triggering work', () => {
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); };
  const state = { current: { status: 'prepared', sourceName: 'bird.png', error: '<b>Generation panel unavailable.</b>' }, running: false, starting: false };
  const updateControls = dashboardFunction('updateControls', 'let tripoFilters', { $, state, hasSavedExport: () => false, gpt: null });
  updateControls();
  assert.equal($('recovery').hidden, false);
  assert.match($('recovery-detail').textContent, /^<b>Generation panel unavailable\.<\/b>/);
  assert.match($('recovery-detail').textContent, /has not been submitted/);
  assert.match($('recovery-detail').textContent, /Resume uploads it again/);
  assert.equal($('recovery-detail').innerHTML, undefined);
  assert.equal(state.current.status, 'prepared');
});
