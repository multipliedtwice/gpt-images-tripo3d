import { puppeteer } from '/Users/danilt/.nvm/versions/node/v24.18.1/lib/node_modules/chrome-devtools-mcp/build/src/third_party/index.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const store = dirname(fileURLToPath(import.meta.url));
const root = resolve(store, '..');
const executablePath = '/Users/danilt/.cache/puppeteer/chrome/mac_arm-154.0.8037.92/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const definition = JSON.parse(await readFile(join(store, 'art-direction.json'), 'utf8'));
await readFile(join(store, 'illustration.png'));
const profile = await mkdtemp(join(tmpdir(), 'tripo-campaign-'));
let browser;
try {
  browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: profile, enableExtensions: [root] });
  const worker = browser.targets().find(target => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://')) ||
    await browser.waitForTarget(target => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://'), { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  const app = await browser.newPage();
  await app.setViewport({ width: 1114, height: 1000, deviceScaleFactor: 1 });
  await app.goto(`chrome-extension://${extensionId}/dashboard.html`, { waitUntil: 'networkidle0' });
  await app.waitForSelector('#gpt-prompts');
  await app.type('#gpt-prompts', 'Create an image of a wooden shipping crate, three-quarter view, isolated background.');
  const captures = {};
  async function capture(name, selector) {
    const element = await app.$(selector);
    if (!element) throw new Error(`Missing capture: ${selector}`);
    captures[name] = `data:image/png;base64,${Buffer.from(await element.screenshot({ type: 'png' })).toString('base64')}`;
  }
  await capture('overview', '#view-gpt .status-card');
  await capture('gpt-connect', '#view-gpt .setup .card:nth-child(1)');
  await capture('gpt-prompt', '#view-gpt .setup .card:nth-child(2)');
  await capture('gpt-run', '#view-gpt .setup .card:nth-child(3)');
  await app.click('#tab-tripo');
  await app.waitForSelector('#view-tripo:not([hidden])');
  await capture('model-folder', '#view-tripo .setup .card:nth-child(1)');
  await capture('model-connect', '#view-tripo .setup .card:nth-child(2)');
  await capture('model-run', '#view-tripo .setup .card:nth-child(3)');
  await app.close();
  const page = await browser.newPage();
  for (const asset of definition.assets) {
    await page.setViewport({ width: asset.width, height: asset.height, deviceScaleFactor: 1 });
    const url = new URL(pathToFileURL(join(store, 'campaign.html')));
    url.searchParams.set('asset', asset.query);
    await page.goto(url.href, { waitUntil: 'load' });
    await page.evaluate(values => {
      for (const image of document.querySelectorAll('[data-capture]')) {
        const value = values[image.dataset.capture];
        if (!value) throw new Error(`Missing capture data: ${image.dataset.capture}`);
        image.src = value;
      }
    }, captures);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map(image => image.decode()));
    });
    const geometry = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, frame: document.querySelector('#frame').getBoundingClientRect().toJSON() }));
    if (geometry.width !== asset.width || geometry.height !== asset.height || geometry.frame.width !== asset.width || geometry.frame.height !== asset.height) throw new Error(`Incorrect dimensions or overflow for ${asset.query}`);
    const png = Buffer.from(await page.screenshot({ type: 'png', omitBackground: false }));
    if (png.readUInt32BE(16) !== asset.width || png.readUInt32BE(20) !== asset.height || png[25] !== 2) throw new Error(`Expected opaque RGB PNG for ${asset.query}`);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(store, asset.output), png);
  }
} finally {
  if (browser) await browser.close();
  await rm(profile, { recursive: true, force: true });
}
