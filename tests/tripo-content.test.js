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
        if (part === 'a[href*="/workspace/generate/"]') return this.tagName === 'A' && (attrs.href || '').includes('/workspace/generate/');
        if (part === 'button[aria-label="Upgrade" i]') return this.tagName === 'BUTTON' && attrs['aria-label'] === 'Upgrade';
        const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
        return !!attribute && attrs[attribute[1]] !== undefined && (attribute[2] === undefined || attrs[attribute[1]] === attribute[2]);
      });
    },
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; },
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
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
  return { api: context.fixture, request, button, input, panel, unrelated, body, location: context.location, advance: ms => { now += ms; }, confirm: () => {
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

const studioURL = id => `https://studio.tripo3d.ai/workspace/generate/${id}`;
const addNode = (parent, node) => { node.parentElement = parent; parent.childNodes.push(node); return node; };
const selectModel = (page, id) => { page.location.pathname = `/workspace/generate/${id}`; page.location.href = studioURL(id); };
const assetLink = (id, preview = false) => {
  const anchor = element('a', preview ? [element('img')] : [], { href: studioURL(id) });
  anchor.href = studioURL(id);
  return anchor;
};
const modelStatus = (page, id = 'new-model') => page.request({ type: 'tripo:status', jobId: 'job', baseline: { modelId: 'old-model', assetIds: ['old-model'] }, ...(id ? { modelUrl: studioURL(id) } : {}) });

test('stable empty selected model fails after settling rather than counting navigation as an asset', async () => {
  const page = fixture([price('55')]); selectModel(page, 'new-model');
  addNode(page.body, assetLink('new-model'));
  addNode(page.body, element('p', ['Ready For A New 3D Model?']));
  assert.equal((await modelStatus(page)).state, 'waiting');
  page.advance(14999); assert.equal((await modelStatus(page)).state, 'waiting');
  page.advance(1);
  const result = await modelStatus(page);
  assert.equal(result.code, 'MODEL_UNAVAILABLE');
  assert.equal(result.state, 'failed');
  assert.equal(page.button.clicks, 0);
});

test('temporary empty state recovers when the real asset and export appear', async () => {
  const page = fixture([price('55')]); selectModel(page, 'new-model');
  addNode(page.body, element('p', ['Ready For A New 3D Model?']));
  assert.equal((await modelStatus(page)).state, 'waiting');
  page.advance(10000);
  addNode(page.body, assetLink('new-model', true));
  addNode(page.body, element('button', ['Export'], { 'data-trace-key': 'studio.workspace_generate.try_export_button', 'data-trace-params': '{"project_id":"new-model"}' }));
  assert.equal((await modelStatus(page)).state, 'waiting');
  page.advance(2500); assert.equal((await modelStatus(page)).state, 'ready');
});

test('busy workspace does not become unavailable and nav-only new route is not published', async () => {
  const page = fixture([price('55')]); selectModel(page, 'new-model');
  addNode(page.body, assetLink('new-model'));
  addNode(page.body, element('p', ['Ready For A New 3D Model?']));
  addNode(page.body, element('div', [], { role: 'progressbar' }));
  assert.equal((await modelStatus(page)).state, 'waiting');
  page.advance(30000); assert.equal((await modelStatus(page)).state, 'waiting');
  const discovered = await modelStatus(page, null);
  assert.equal(discovered.state, 'waiting');
  assert.equal(discovered.modelId, null);
});

test('baseline and mismatched export controls never become ready', async () => {
  const page = fixture([price('55')]); selectModel(page, 'old-model');
  addNode(page.body, assetLink('old-model', true));
  addNode(page.body, element('button', ['Export'], { 'data-trace-key': 'studio.workspace_generate.try_export_button', 'data-trace-params': '{"project_id":"old-model"}' }));
  const baseline = await modelStatus(page, null);
  assert.equal(baseline.state, 'waiting');
  assert.equal(baseline.modelId, null);
  selectModel(page, 'new-model');
  assert.equal((await modelStatus(page)).state, 'waiting');
  page.advance(30000); assert.equal((await modelStatus(page)).state, 'waiting');
});

test('dashboard propagates the unavailable code without modifying the job', async () => {
  const state = { current: { id: 'job', status: 'generating', baseline: { assetIds: [] } } };
  let saved = false;
  const waitForModel = dashboardFunction('waitForModel', 'const exportStep', {
    state, ensureStudio: async () => {}, studioMessage: async () => ({ state: 'failed', code: 'MODEL_UNAVAILABLE', detail: 'Saved model unavailable' }),
    errorWith: (message, code) => Object.assign(new Error(message), { code }), saveJob: async () => { saved = true; }
  });
  await assert.rejects(waitForModel(), { code: 'MODEL_UNAVAILABLE' });
  assert.equal(state.current.status, 'generating');
  assert.equal(saved, false);
});

test('unavailable retry control is visible only for eligible jobs and disabled while busy', () => {
  for (const [job, busy, hidden] of [
    [{ status: 'generating', modelId: 'model', errorCode: 'MODEL_UNAVAILABLE' }, false, false],
    [{ status: 'submitting', modelId: 'model', errorCode: 'MODEL_UNAVAILABLE' }, true, false],
    [{ status: 'generating', modelId: 'model', errorCode: 'OTHER' }, false, true],
    [{ status: 'generating', modelId: 'model', errorCode: 'MODEL_UNAVAILABLE', exported: true }, false, true],
    [{ status: 'exporting', modelId: 'model', errorCode: 'MODEL_UNAVAILABLE' }, false, true]
  ]) {
    const nodes = new Map();
    const $ = id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); };
    const state = { current: job, root: {}, tabId: 1, running: busy, starting: false };
    dashboardFunction('updateControls', 'let tripoFilters', { $, state, hasSavedExport: value => !!value?.exported, gpt: null })();
    assert.equal($('regenerate').hidden, hidden);
    assert.equal($('regenerate').disabled, busy);
  }
});

const retryFixture = (responses, overrides = {}) => {
  let now = 0;
  const job = { id: 'job', sourceName: 'bird.png', sourceHash: 'hash', folderName: 'bird', status: 'generating', modelId: 'new-model', modelUrl: studioURL('new-model'), baseline: { assetIds: ['old-model'] }, errorCode: 'MODEL_UNAVAILABLE', ...overrides };
  const state = { root: {}, tabId: 1, current: { ...job }, running: false, starting: false };
  const calls = [];
  const regenerateJob = dashboardFunction('regenerateJob', 'const importExport', {
    state, window: { confirm: () => true }, updateControls() {}, requestFolderPermission: async () => {},
    navigator: { locks: { request: async (name, options, action) => action({}) } }, LOCK_NAME: 'lock',
    errorWith: (message, code) => Object.assign(new Error(message), { code }), getJob: async () => ({ ...job }),
    hasSavedExport: value => !!value.exported, ensureStudio: async () => {}, Date: { now: () => now }, sleep: async ms => { now += ms; },
    studioMessage: async (type, payload) => { calls.push({ type, payload }); return type === 'tripo:status' ? responses.shift() || { state: 'waiting' } : { ok: true }; },
    saveJob: async changes => { calls.push({ type: 'save', changes }); Object.assign(state.current, changes); },
    startRun: async () => { calls.push({ type: 'start' }); }
  });
  return { job, state, calls, regenerateJob };
};

test('explicit retry rechecks unavailability before clearing only generation fields', async () => {
  const fixture = retryFixture([{ state: 'waiting' }, { state: 'failed', code: 'MODEL_UNAVAILABLE' }]);
  await fixture.regenerateJob();
  assert.deepEqual(fixture.calls.map(call => call.type), ['tripo:status', 'tripo:status', 'tripo:forget-job', 'save', 'start']);
  assert.equal(fixture.calls[0].payload.resetUnavailableCheck, true);
  assert.equal(fixture.calls[1].payload.resetUnavailableCheck, false);
  assert.equal(fixture.state.current.id, fixture.job.id);
  assert.equal(fixture.state.current.sourceHash, fixture.job.sourceHash);
  assert.equal(fixture.state.current.folderName, fixture.job.folderName);
  assert.equal(fixture.state.current.modelId, null);
});

test('retry preserves the job if the model appears, remains uncertain, or a saved model is ineligible', async () => {
  for (const [responses, overrides] of [
    [[{ state: 'ready' }], {}],
    [[{ state: 'waiting' }], {}],
    [[], { errorCode: 'OTHER' }],
    [[], { exported: true }]
  ]) {
    const fixture = retryFixture(responses, overrides);
    await assert.rejects(fixture.regenerateJob());
    assert.deepEqual(fixture.state.current, fixture.job);
    assert.equal(fixture.calls.some(call => ['tripo:forget-job', 'save', 'start'].includes(call.type)), false);
  }
});

test('fresh unavailable check resets the prior settling interval', async () => {
  const page = fixture([price('55')]); selectModel(page, 'new-model');
  addNode(page.body, element('p', ['Ready For A New 3D Model?']));
  await modelStatus(page); page.advance(15000);
  assert.equal((await modelStatus(page)).code, 'MODEL_UNAVAILABLE');
  const fresh = await page.request({ type: 'tripo:status', jobId: 'job', baseline: { assetIds: ['old-model'] }, modelUrl: studioURL('new-model'), resetUnavailableCheck: true });
  assert.equal(fresh.state, 'waiting');
  page.advance(15000);
  assert.equal((await modelStatus(page)).code, 'MODEL_UNAVAILABLE');
});
