(() => {
  if (globalThis.__tripoFolderContentInstalled) return;
  globalThis.__tripoFolderContentInstalled = true;

  const CONTENT_SOURCE = 'tripo-folder-content';
  const PAGE_SOURCE = 'tripo-folder-page';
  const EXPORT_SELECTOR = '[data-trace-key="studio.workspace_generate.try_export_button"]';
  const DELETE_ICON = '[class~="i-tripo:delete"]';
  const MODEL_LINK = 'a[href*="/workspace/generate/"]';
  const MEDIA = 'img,[style*="url("]';
  const IMAGE_ACCEPT = /^(?:image\/(?:\*|png|jpe?g|webp)|\.(?:png|jpe?g|webp))$/i;
  const MODEL_ACCEPT = /^(?:\.(?:fbx|obj|stl|glb|gltf|usdz|3mf|ply|dae)|model\/.+)$/i;
  const PREPARE_TIMEOUT = 8000;
  const CONFIRM_TIMEOUT = 45000;
  const submittedJobs = new Set();
  const allowedHosts = new Set(['studio.tripo3d.ai', 'www.tripo3d.ai', 'tripo3d.ai']);
  let uploaded = null;
  let readyCandidate = null;
  let lastReady = null;
  let capture = null;
  let mutation = null;
  let recoveringModel = null;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const text = element => (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
  const fail = (message, code) => Object.assign(new Error(message), { code });
  const visible = element => {
    if (!element?.isConnected || element.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const enabled = element => visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true' && !element.closest('[inert]');
  const all = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));
  const visibleAll = (selector, scope = document) => all(selector, scope).filter(visible);
  const unique = values => [...new Set(values.filter(Boolean))];
  const generateButton = () => visibleAll('button,[role="button"]').find(element => /^Generate(?:\s+[\d,.]+)?$/i.test(text(element))) || null;
  const exportButton = () => visibleAll(EXPORT_SELECTOR).find(enabled) || visibleAll('button').find(element => /^Export$/i.test(text(element)) && !element.closest('[role="dialog"],[data-reka-popper-content-wrapper],[data-radix-popper-content-wrapper]')) || null;
  const acceptTokens = input => (input.getAttribute('accept') || '').split(',').map(token => token.trim()).filter(Boolean);
  const isImageInput = input => {
    const tokens = acceptTokens(input);
    return input.isConnected && !input.disabled && tokens.some(token => IMAGE_ACCEPT.test(token)) && !tokens.some(token => MODEL_ACCEPT.test(token));
  };
  const generationPanel = () => generateButton()?.closest('[data-workspace-panel]') || null;
  const imageInput = () => {
    const panel = generationPanel();
    const scoped = panel ? all('input[type="file"]', panel).find(isImageInput) : null;
    if (scoped || (panel && sourceThumbnails(panel).length)) return scoped || null;
    return all('input[type="file"]').find(isImageInput) || null;
  };
  const panelFor = element => {
    let panel = element?.parentElement;
    const button = generateButton();
    while (panel && panel !== document.body) {
      if (button && panel.contains(button)) return panel;
      panel = panel.parentElement;
    }
    return null;
  };
  const previewSources = panel => panel ? unique(all('img', panel).map(image => image.currentSrc || image.src).concat(all('[style*="url("]', panel).map(element => element.style.backgroundImage))) : [];
  const modelPreviewSources = panel => panel ? all(MODEL_LINK, panel).flatMap(previewSources) : [];
  const sourcePanel = fallback => (fallback?.isConnected ? fallback : null) || generationPanel() || panelFor(imageInput());
  const actionable = element => !!element?.isConnected && !element.disabled && element.getAttribute('aria-disabled') !== 'true' && !element.closest('[hidden],[inert]');
  const thumbnailOf = (button, panel) => {
    for (let node = button.parentElement; node && node !== panel; node = node.parentElement) {
      if (node.matches(MEDIA) || node.querySelector(MEDIA)) return node;
    }
    return null;
  };
  const isSourceThumbnail = (button, thumbnail) => !!thumbnail
    && actionable(button)
    && !thumbnail.contains(generateButton())
    && !thumbnail.closest(MODEL_LINK)
    && !thumbnail.querySelector(`${MODEL_LINK},canvas,[data-workspace-panel]`)
    && all(DELETE_ICON, thumbnail).length === 1
    && text(thumbnail).length < 200
    && !/model|project|asset|history|task/i.test(`${button.getAttribute('aria-label') || ''} ${button.title || ''}`);
  const sourceThumbnails = panel => unique(all(DELETE_ICON, panel).map(icon => icon.closest('button,[role="button"]')))
    .filter(button => button !== panel && panel.contains(button))
    .map(button => ({ button, thumbnail: thumbnailOf(button, panel) }))
    .filter(({ button, thumbnail }) => isSourceThumbnail(button, thumbnail));
  const replaceButton = panel => visibleAll('button,[role="button"]', panel).find(element => enabled(element) && /^(Replace image|Change image|Upload image|Upload another image)$/i.test(text(element) || element.getAttribute('aria-label') || '')) || null;
  const prepareUploadInput = async () => {
    const existing = imageInput();
    if (existing) return { input: existing, staleSources: [] };
    const panel = generationPanel();
    if (!panel) throw fail('Could not identify the generation panel containing the Generate button. Generate has not been clicked.', 'GENERATION_PANEL_NOT_FOUND');
    const candidates = sourceThumbnails(panel);
    if (candidates.length > 1) throw fail('More than one delete control in the generation panel looks like the source-image thumbnail, so none was clicked. Remove the previous input image in Studio, then resume; Generate has not been clicked.', 'SOURCE_THUMBNAIL_AMBIGUOUS');
    const thumbnail = candidates[0]?.thumbnail || null;
    const target = candidates[0]?.button || replaceButton(panel);
    if (!target) throw fail('The image-upload input and the previous source-image remove button were not found in the generation panel. Remove the previous input image in Studio, then resume; Generate has not been clicked.', 'UPLOAD_INPUT_NOT_FOUND');
    const staleSources = thumbnail ? previewSources(thumbnail) : [];
    target.click();
    const input = await waitFor(() => {
      const current = imageInput();
      return current && !(thumbnail?.isConnected && visible(thumbnail)) ? current : null;
    }, PREPARE_TIMEOUT, fail('Studio did not restore the image uploader after the previous input image was cleared. Check Studio, then resume; Generate has not been clicked.', 'UPLOAD_INPUT_NOT_RESTORED'));
    return { input, staleSources };
  };

  const workspaceURL = raw => {
    let url;
    try {
      url = new URL(raw, location.href);
    } catch {
      throw fail('The model URL is invalid.', 'INVALID_MODEL_URL');
    }
    if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname) || url.origin !== location.origin || !/^\/workspace\/generate\/[^/]+\/?$/.test(url.pathname)) throw fail('Open the model in this Tripo Studio tab before resuming.', 'INVALID_MODEL_URL');
    url.hash = '';
    return url;
  };
  const idFromURL = raw => {
    try {
      const url = new URL(raw, location.href);
      if (url.origin !== location.origin) return null;
      const match = url.pathname.match(/^\/workspace\/generate\/([^/]+)\/?$/);
      if (!match) return null;
      const slug = decodeURIComponent(match[1]);
      return slug.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i)?.[1]?.toLowerCase() || slug;
    } catch {
      return null;
    }
  };
  const exportModelId = button => {
    try {
      const details = JSON.parse(button?.getAttribute('data-trace-params') || '{}');
      return typeof details.project_id === 'string' ? details.project_id.toLowerCase() : null;
    } catch {
      return null;
    }
  };
  const assets = () => all('a[href*="/workspace/generate/"]').map(anchor => ({ id: idFromURL(anchor.href), url: anchor.href, anchor })).filter(asset => asset.id);
  const baselineNow = () => ({ url: location.href, modelId: idFromURL(location.href), assetIds: unique(assets().map(asset => asset.id)), at: Date.now() });
  const currentCost = () => {
    const match = text(generateButton()).match(/^Generate\s+([\d,.]+)$/i);
    if (!match) return null;
    const value = Number(match[1].replace(/,/g, ''));
    return Number.isFinite(value) ? value : null;
  };
  const parseCredits = value => {
    const match = /^([\d,.]+)\s*(k)?$/i.exec(String(value || '').trim());
    if (!match) return null;
    const number = Number(match[1].replace(/,/g, '')) * (match[2] ? 1000 : 1);
    return Number.isFinite(number) ? Math.round(number) : null;
  };
  const currentBalance = () => {
    const pills = [...visibleAll('button[aria-label="Upgrade" i]').map(button => button.parentElement), ...visibleAll('[class*="i-tripo:bolt"]').map(icon => icon.parentElement).filter(pill => pill && !pill.closest('button,[role="button"]'))];
    for (const pill of pills) {
      const balance = pill && all('p', pill).map(element => parseCredits(element.getAttribute('title')) ?? parseCredits(text(element))).find(value => value !== null);
      if (balance != null) return balance;
    }
    return null;
  };
  const currentModel = () => visibleAll('[role="combobox"]').map(text).find(value => /\bH\d(?:\.\d)?\b|\bv\d(?:\.\d)?\b|best quality|AI model/i.test(value)) || null;
  const shortMessages = () => visibleAll('[role="alert"],[role="status"],[data-sonner-toast],[data-radix-toast-viewport] li,[class*="toast"]')
    .map(text).filter(value => value.length > 0 && value.length < 1000);
  const failureMessage = () => shortMessages().find(value => /generation failed|failed to generate|insufficient credits|not enough credits|generation error|upload failed|failed to upload|session expired|please log in|please sign in|rate limit|too many requests/i.test(value)) || null;
  const busyMessage = () => {
    const progress = visibleAll('[role="progressbar"],[aria-busy="true"],[data-generating="true"]');
    if (progress.length) return text(progress[0]) || 'Tripo is processing the model.';
    const candidates = visibleAll('span,p,small,div').filter(element => element.children.length < 3).map(text);
    return candidates.find(value => value.length < 140 && /^(?:Generating|Uploading|Queued|In queue|Generation in progress|Processing your model|Preparing your model|Texturing your model)(?:\b|\s|[.:…])/i.test(value)) || null;
  };
  const ensureWorkspace = () => {
    if (location.protocol !== 'https:' || !allowedHosts.has(location.hostname) || !location.pathname.startsWith('/workspace')) throw fail('Open the Generate workspace in your signed-in Tripo Studio tab.', 'WRONG_PAGE');
  };
  const waitFor = async (predicate, timeout, error) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = predicate();
      if (result) return result;
      await sleep(200);
    }
    throw error;
  };
  const inspect = () => {
    ensureWorkspace();
    return { ok: true, cost: currentCost(), balance: currentBalance(), model: currentModel(), baseline: baselineNow(), uploadReady: !!imageInput() && !busyMessage(), exportReady: !!exportButton() && enabled(exportButton()) && !busyMessage(), url: location.href };
  };

  const upload = async message => {
    ensureWorkspace();
    if (busyMessage()) throw fail('Wait for the current Studio operation to finish before uploading another image.', 'STUDIO_BUSY');
    if (typeof message.name !== 'string' || typeof message.base64 !== 'string' || !/^image\/(png|jpe?g|webp)$/i.test(message.mime || '')) throw fail('Choose a PNG, JPEG, or WebP image.', 'INVALID_IMAGE');
    if (message.base64.length > 28 * 1024 * 1024) throw fail('Tripo Studio accepts source images up to 20 MB.', 'IMAGE_TOO_LARGE');
    if (typeof message.jobId === 'string' && submittedJobs.has(message.jobId)) throw fail('Generate was already clicked for this item. Resume its existing result instead of uploading again.', 'ALREADY_SUBMITTED');
    let binary;
    try {
      binary = atob(message.base64);
    } catch {
      throw fail('The source image could not be decoded.', 'INVALID_IMAGE');
    }
    if (!binary.length || binary.length > 20 * 1024 * 1024) throw fail('The source image must be nonempty and no larger than 20 MB.', 'IMAGE_TOO_LARGE');
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const file = new File([bytes], message.name, { type: message.mime, lastModified: Number(message.lastModified) || Date.now() });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    uploaded = null;
    lastReady = null;
    const { input, staleSources } = await prepareUploadInput();
    const panel = generationPanel() || panelFor(input);
    if (!panel) throw fail('Could not identify the generation panel around the image input and Generate button. Generate has not been clicked.', 'GENERATION_PANEL_NOT_FOUND');
    const ignored = new Set([...previewSources(panel), ...staleSources]);
    const nameShown = text(panel).includes(message.name);
    const freshSources = scope => {
      const models = new Set(modelPreviewSources(scope));
      return previewSources(scope).filter(source => !ignored.has(source) && !models.has(source));
    };
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const started = Date.now();
    await waitFor(() => {
      const failure = failureMessage();
      if (failure) throw fail(failure, 'UPLOAD_FAILED');
      const currentPanel = sourcePanel(panel);
      const hasPreview = freshSources(currentPanel).length > 0;
      const hasName = !nameShown && !!currentPanel && text(currentPanel).includes(message.name);
      return Date.now() - started > 1000 && (hasPreview || hasName) && enabled(generateButton()) && !busyMessage();
    }, CONFIRM_TIMEOUT, fail('Studio has not confirmed the new image preview. Check for an image-crop dialog or upload error, then resume; Generate has not been clicked.', 'UPLOAD_NOT_CONFIRMED'));
    const currentPanel = sourcePanel(panel);
    const addedSources = freshSources(currentPanel);
    const localSources = addedSources.filter(source => /(?:blob:|data:image\/)/i.test(source));
    uploaded = { name: message.name, size: file.size, at: Date.now(), panel: currentPanel, file, sourceMarkers: localSources.length ? localSources : addedSources };
    return { ok: true, name: message.name, cost: currentCost(), baseline: baselineNow() };
  };

  const generate = async message => {
    ensureWorkspace();
    if (typeof message.jobId !== 'string' || !message.jobId) throw fail('This generation is missing its queue job ID.', 'INVALID_JOB');
    if (submittedJobs.has(message.jobId)) throw fail('Generate was already clicked for this item. Wait for its model or resume the existing result.', 'ALREADY_SUBMITTED');
    if (!uploaded) throw fail('Upload and confirm this source image before generating.', 'IMAGE_NOT_CONFIRMED');
    const panel = sourcePanel(uploaded.panel);
    const currentSources = new Set(previewSources(panel));
    const selectedFile = imageInput()?.files?.[0];
    const changedFile = selectedFile && (selectedFile.name !== uploaded.file.name || selectedFile.size !== uploaded.file.size || selectedFile.lastModified !== uploaded.file.lastModified);
    const lostPreview = uploaded.sourceMarkers.length ? uploaded.sourceMarkers.some(source => !currentSources.has(source)) : selectedFile !== uploaded.file;
    if (!panel || changedFile || lostPreview) throw fail('The input image changed after the queue uploaded it. Resume to upload this job’s source image again; Generate has not been clicked.', 'IMAGE_CHANGED');
    const button = generateButton();
    if (!enabled(button) || busyMessage()) throw fail('The Generate button is not ready. Check Studio for a dialog or an unfinished operation.', 'GENERATE_NOT_READY');
    const cost = currentCost();
    if (cost === null) throw fail('Could not read the current credit charge from the Generate button. Check the Studio settings and retry.', 'COST_UNKNOWN');
    if (Number.isFinite(Number(message.maxCredits)) && cost > Number(message.maxCredits)) throw fail(`Studio currently shows ${cost} credits, above the configured ${Number(message.maxCredits)}-credit limit.`, 'COST_LIMIT');
    const balance = currentBalance();
    if (balance !== null && balance < cost) throw fail(`Tripo shows ${balance} credits, below the ${cost}-credit generation cost. Add credits, then resume; Generate has not been clicked.`, 'INSUFFICIENT_CREDITS');
    const baseline = message.baseline && Array.isArray(message.baseline.assetIds) ? message.baseline : baselineNow();
    if (idFromURL(location.href) !== (baseline.modelId || null)) throw fail('The selected Studio model changed after the queue prepared this generation. Resume to inspect it again.', 'BASELINE_CHANGED');
    submittedJobs.add(message.jobId);
    recoveringModel = null;
    readyCandidate = null;
    lastReady = null;
    uploaded = null;
    button.click();
    return { ok: true, baseline, cost, submitted: true, submittedAt: Date.now() };
  };

  const status = async message => {
    ensureWorkspace();
    if (!message.baseline && !message.modelUrl) throw fail('The queue needs the saved generation baseline or the expected model URL before checking a result.', 'BASELINE_REQUIRED');
    const failed = failureMessage();
    if (failed) return { ok: true, state: 'failed', detail: failed, modelUrl: null, modelId: null };
    const baseline = message.baseline || { modelId: null, assetIds: [] };
    const expected = message.modelUrl ? idFromURL(workspaceURL(message.modelUrl).href) : null;
    const oldIds = new Set([baseline.modelId, ...(baseline.assetIds || [])].filter(Boolean));
    const currentId = idFromURL(location.href);
    const newAssets = assets().filter(asset => !oldIds.has(asset.id));
    const newIds = unique(newAssets.map(asset => asset.id));
    const currentIsCandidate = currentId && (expected ? currentId === expected : !oldIds.has(currentId));
    if (!expected && newIds.length > 1) {
      readyCandidate = null;
      lastReady = null;
      return { ok: true, state: 'failed', modelUrl: null, modelId: null, detail: 'More than one new model appeared. Select the correct model in Studio and use “Use selected model” in the runner.' };
    }
    if (!currentIsCandidate) {
      readyCandidate = null;
      lastReady = null;
      if (expected) {
        recover({ url: message.modelUrl });
        return { ok: true, state: 'waiting', modelUrl: message.modelUrl, modelId: expected, detail: 'Opening the saved model in Studio and waiting for its export controls.' };
      }
      if (newIds.length === 1) {
        const asset = newAssets.find(item => item.id === newIds[0]);
        if (visible(asset.anchor)) {
          asset.anchor.click();
          return { ok: true, state: 'waiting', modelUrl: asset.url, modelId: asset.id, detail: 'Opening the new model created after this image was submitted.' };
        }
        return { ok: true, state: 'waiting', modelUrl: asset.url, modelId: asset.id, detail: 'A new model exists. Waiting for Studio to select it.' };
      }
      return { ok: true, state: 'waiting', modelUrl: null, modelId: null, detail: busyMessage() || 'Waiting for a new model identity. The previously selected model will not be exported.' };
    }
    recoveringModel = null;
    const button = exportButton();
    const boundId = exportModelId(button);
    const busy = busyMessage();
    const modelUrl = location.href;
    if (!enabled(button) || busy || (boundId && boundId !== currentId)) {
      readyCandidate = null;
      lastReady = null;
      return { ok: true, state: 'waiting', modelUrl, modelId: currentId, detail: busy || 'Waiting for this model’s Export button to become ready.' };
    }
    if (!readyCandidate || readyCandidate.modelId !== currentId) readyCandidate = { modelId: currentId, at: Date.now() };
    if (Date.now() - readyCandidate.at < 2500) return { ok: true, state: 'waiting', modelUrl, modelId: currentId, detail: 'The new model is ready; checking that its selection has settled.' };
    lastReady = { modelId: currentId, modelUrl, jobId: message.jobId || null };
    return { ok: true, state: 'ready', modelUrl, modelId: currentId, detail: 'The new model is selected and ready to export.' };
  };

  const disarm = () => {
    if (capture) window.postMessage({ source: CONTENT_SOURCE, type: 'disarm', token: capture.token }, location.origin);
    capture = null;
    return { ok: true };
  };
  const arm = async (jobId, modelId) => {
    disarm();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const token = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    capture = { token, jobId, modelId, acceptedId: null, armed: false, started: false, expiresAt: Date.now() + 10 * 60 * 1000 };
    window.postMessage({ source: CONTENT_SOURCE, type: 'arm', token, jobId, modelId, expiresAt: capture.expiresAt }, location.origin);
    await waitFor(() => capture?.token === token && capture.armed, 3000, fail('The export capture hook did not load. Reload the Studio tab after installing the extension, then retry exporting this model.', 'CAPTURE_NOT_READY'));
    return token;
  };
  const exportPanels = () => {
    const selectors = '[role="dialog"],[role="alertdialog"],[data-reka-popper-content-wrapper],[data-radix-popper-content-wrapper],[data-state="open"][data-side],[role="menu"],[role="listbox"]';
    const formatLabel = /^(?:FBX|GLB|GLTF|OBJ|STL|USDZ)(?:\s*\([^)]*\))?$/i;
    return visibleAll(selectors).filter(element => /\bFBX\b|\bGLB\b|file format|export model|download model/i.test(text(element))
      || visibleAll('button,[role="option"],[role="radio"],[role="combobox"],label,[role="button"]', element).some(control => formatLabel.test(text(control)))
      || visibleAll('select', element).some(select => all('option', select).some(option => formatLabel.test(text(option)))));
  };
  const optionFBX = panels => {
    for (const panel of panels) {
      const native = all('select', panel).find(select => all('option', select).some(option => /^\s*FBX\b/i.test(text(option))));
      if (native) return { type: 'select', element: native, option: all('option', native).find(option => /^\s*FBX\b/i.test(text(option))) };
      const options = visibleAll('button,[role="option"],[role="radio"],label,[role="button"]', panel).filter(element => /^FBX(?:\s*\([^)]*\))?$/i.test(text(element)));
      if (options.length === 1) return { type: 'click', element: options[0] };
      const labels = visibleAll('span,div', panel).filter(element => element.children.length === 0 && /^FBX$/i.test(text(element)));
      if (labels.length === 1) {
        const label = labels[0];
        const owner = label.closest('button,[role="option"],[role="radio"],label,[role="button"]') || label.parentElement;
        if (owner && panel.contains(owner) && text(owner).length < 140) return { type: 'click', element: owner };
      }
    }
    return null;
  };
  const chooseFBX = async panels => {
    let option = optionFBX(panels);
    if (!option) {
      const combos = panels.flatMap(panel => visibleAll('[role="combobox"]', panel)).filter(element => /\bGLB\b|\bGLTF\b|\bOBJ\b|\bSTL\b|\bFBX\b|format/i.test(text(element) + ' ' + (element.getAttribute('aria-label') || '')));
      if (combos.length === 1 && enabled(combos[0])) {
        if (/^FBX\b/i.test(text(combos[0]))) return;
        combos[0].click();
        option = await waitFor(() => optionFBX(exportPanels()), 2500, fail('The format menu opened, but its FBX option could not be identified. Choose FBX manually, then retry export.', 'FBX_OPTION_NOT_FOUND'));
      }
    }
    if (!option) throw fail('The export controls do not expose an identifiable FBX option. Choose FBX in Studio, or download the FBX/ZIP and use “Use downloaded FBX/ZIP” in the runner.', 'FBX_OPTION_NOT_FOUND');
    if (option.type === 'select') {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(option.element, option.option.value);
      option.element.dispatchEvent(new Event('input', { bubbles: true }));
      option.element.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      if (!enabled(option.element)) throw fail('The FBX format option is disabled for this model or plan.', 'FBX_DISABLED');
      option.element.click();
    }
    await sleep(350);
  };

  const exportModel = async message => {
    ensureWorkspace();
    if (typeof message.jobId !== 'string' || !message.jobId) throw fail('This export is missing its queue job ID.', 'INVALID_JOB');
    const modelId = idFromURL(location.href);
    const toolbar = exportButton();
    if (!lastReady || lastReady.modelId !== modelId || (lastReady.jobId && lastReady.jobId !== message.jobId)) throw fail('Confirm the correct generated model before exporting. Use “Use selected model” if you opened it manually.', 'MODEL_NOT_CONFIRMED');
    if (!enabled(toolbar) || busyMessage() || (exportModelId(toolbar) && exportModelId(toolbar) !== modelId)) throw fail('The selected model is not ready to export.', 'EXPORT_NOT_READY');
    let panels = exportPanels();
    if (!panels.length) {
      toolbar.click();
      panels = await waitFor(() => {
        const found = exportPanels();
        return found.length ? found : null;
      }, 5000, fail('The export dialog could not be identified from the page. Open it manually and choose FBX, then retry export or import the downloaded file.', 'EXPORT_UI_NOT_FOUND'));
    }
    await arm(message.jobId, modelId);
    try {
      await chooseFBX(panels);
      if (capture?.started) return { ok: true, initiated: true, modelId, modelUrl: location.href };
      if (idFromURL(location.href) !== modelId) throw fail('Studio changed the selected model while opening export. Reselect the intended result and retry export.', 'MODEL_CHANGED');
      panels = exportPanels();
      const buttons = unique(panels.flatMap(panel => visibleAll('button,[role="button"],a[download]', panel))).filter(element => enabled(element) && /^(?:Export|Download)(?:\s+(?:Model|FBX|File|Now|\.FBX))?$/i.test(text(element)) && element !== toolbar);
      if (buttons.length !== 1) throw fail('FBX is selected, but the final Export/Download button is ambiguous. Click the export button manually while the runner is waiting, or import the downloaded file.', 'EXPORT_BUTTON_NOT_FOUND');
      buttons[0].click();
      return { ok: true, initiated: true, modelId, modelUrl: location.href };
    } catch (error) {
      if (error.code !== 'EXPORT_BUTTON_NOT_FOUND') disarm();
      throw error;
    }
  };

  const recover = message => {
    ensureWorkspace();
    const url = workspaceURL(message.url);
    const targetId = idFromURL(url.href);
    if (targetId === idFromURL(location.href)) {
      recoveringModel = null;
      return { ok: true, navigating: false, url: location.href };
    }
    if (recoveringModel === targetId) return { ok: true, navigating: true, url: url.href };
    recoveringModel = targetId;
    const anchor = assets().find(asset => asset.id === targetId)?.anchor;
    readyCandidate = null;
    lastReady = null;
    setTimeout(() => {
      if (anchor?.isConnected) anchor.click();
      else location.assign(url.href);
    }, 100);
    return { ok: true, navigating: true, url: url.href };
  };

  window.addEventListener('message', async event => {
    const data = event.data;
    const state = capture;
    if (event.source !== window || event.origin !== location.origin || !state || !data || data.source !== PAGE_SOURCE || data.token !== state.token || data.jobId !== state.jobId) return;
    if (data.type === 'armed') {
      state.armed = true;
      return;
    }
    if (data.type === 'capturing') {
      state.started = true;
      return;
    }
    if (data.type !== 'capture' || !['url', 'begin', 'chunk', 'end', 'error'].includes(data.kind) || typeof data.captureId !== 'string' || data.captureId.length > 100 || Date.now() > state.expiresAt) return;
    if (data.kind === 'chunk' && (typeof data.base64 !== 'string' || data.base64.length > 360000 || !Number.isSafeInteger(data.index) || data.index < 0)) return;
    if (data.kind === 'url' && (typeof data.url !== 'string' || !data.url.startsWith('https://'))) return;
    let captureError = null;
    if (data.kind === 'url' || data.kind === 'begin') {
      const boundIds = unique(all(EXPORT_SELECTOR).filter(element => element.isConnected).map(exportModelId));
      if (!state.modelId || idFromURL(location.href) !== state.modelId || boundIds.length !== 1 || boundIds[0] !== state.modelId) captureError = 'The selected model changed, or its export identity could not be verified, before the file was captured. Select this image’s model and retry export; the source image has been kept.';
      else if (state.acceptedId) captureError = 'Another export started while this image was receiving its model. Retry the intended model’s export.';
      else state.acceptedId = data.captureId;
    } else if (data.kind !== 'error' && state.acceptedId !== data.captureId) {
      captureError = 'The export data does not belong to the verified model capture. Retry exporting the existing model.';
    } else if (state.acceptedId && state.acceptedId !== data.captureId) {
      captureError = 'Another model’s export interrupted this capture. Retry exporting the intended model.';
    }
    if (captureError) {
      disarm();
      try {
        await chrome.runtime.sendMessage({ type: 'tripo:export-captured', jobId: state.jobId, captureId: state.acceptedId || data.captureId, kind: 'error', error: captureError });
      } catch {}
      if (Number.isSafeInteger(data.sequence)) window.postMessage({ source: CONTENT_SOURCE, type: 'ack', token: state.token, sequence: data.sequence, ok: false, error: captureError }, location.origin);
      return;
    }
    state.started = true;
    const payload = { type: 'tripo:export-captured', jobId: state.jobId, captureId: data.captureId, kind: data.kind };
    for (const key of ['url', 'name', 'mime', 'size', 'index', 'base64', 'chunks', 'error']) if (data[key] !== undefined) payload[key] = data[key];
    try {
      const response = await chrome.runtime.sendMessage(payload);
      if (!response || response.ok === false) throw new Error(response?.error || 'The GPT Images to Tripo3d tab did not accept this export.');
      if (Number.isSafeInteger(data.sequence)) window.postMessage({ source: CONTENT_SOURCE, type: 'ack', token: state.token, sequence: data.sequence, ok: true }, location.origin);
    } catch (error) {
      if (Number.isSafeInteger(data.sequence)) window.postMessage({ source: CONTENT_SOURCE, type: 'ack', token: state.token, sequence: data.sequence, ok: false, error: String(error.message || error) }, location.origin);
    }
  });

  const handlers = {
    'tripo:inspect': inspect,
    'tripo:upload': upload,
    'tripo:generate': generate,
    'tripo:status': status,
    'tripo:export': exportModel,
    'tripo:recover': recover,
    'tripo:disarm-export': disarm
  };
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    const handler = handlers[message?.type];
    if (!handler) return false;
    if (sender.id && sender.id !== chrome.runtime.id) return false;
    const mutates = ['tripo:upload', 'tripo:generate', 'tripo:export', 'tripo:recover'].includes(message.type);
    if (mutates && mutation) {
      respond({ ok: false, code: 'OPERATION_BUSY', error: `The previous ${mutation} operation is still running.`, ...(message.type === 'tripo:generate' ? { submitted: submittedJobs.has(message.jobId) } : {}) });
      return false;
    }
    if (mutates) mutation = message.type.replace('tripo:', '');
    Promise.resolve().then(() => handler(message)).then(respond).catch(error => respond({ ok: false, error: String(error.message || error), code: error.code || 'STUDIO_ERROR', ...(message.type === 'tripo:generate' ? { submitted: submittedJobs.has(message.jobId) } : {}) })).finally(() => {
      if (mutates) mutation = null;
    });
    return true;
  });
})();
