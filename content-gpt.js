(() => {
  if (globalThis.__tripoGptContentInstalled) return;
  globalThis.__tripoGptContentInstalled = true;

  const COMPOSER = '#prompt-textarea,form textarea,form [contenteditable="true"]';
  const SEND = '[data-testid="send-button"],#composer-submit-button,button[aria-label="Send prompt"],button[aria-label="Send message"]';
  const SEND_HINT = /\b(?:send|submit)\b/i;
  const NOT_SEND = /voice|dictat|micro|record|attach|upload|stop|expand|model|effort/i;
  const STOP = '[data-testid="stop-button"],button[aria-label^="Stop" i]';
  const TURN_STATE = '[data-talvt-turn-state]';
  const USER_TURN = '[data-user-message-bubble="true"],[data-conversation-role="user"],[data-message-author-role="user"]';
  const RESPONSE = '[data-response-body],[data-message-author-role="assistant"]';
  const IMAGE = '[data-testid="generated-image-gallery"] img,[data-testid="generated-image-preview"] img,img[alt^="Generated image"]';
  const LIMIT = /(?:reached|hit) (?:the |your )?(?:\w+ )?limit|limit (?:for|on) image|too many requests|rate limit|try again (?:later|in \d|after)/i;
  const submittedJobs = new Set();
  let observed = { key: null, at: 0 };

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fail = (message, code, extra = {}) => Object.assign(new Error(message), { code }, extra);
  const text = element => (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
  const all = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));
  const visible = element => !!element?.isConnected && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const ready = element => !!element && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
  const firstVisible = selector => all(selector).find(visible) || null;
  const poll = async (predicate, timeout) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = predicate();
      if (result) return result;
      await sleep(250);
    }
    return null;
  };

  const conversationURL = () => /\/c\/[\w-]+/.test(location.pathname) ? location.origin + location.pathname : null;
  const loggedOut = () => !!document.querySelector('button[aria-label$="Log in to use." i]');
  const turnState = () => all(TURN_STATE).at(-1)?.getAttribute('data-talvt-turn-state') || null;
  const busy = () => !!firstVisible(STOP) || (all(USER_TURN).length > 0 && turnState() !== null && turnState() !== 'complete');
  const lastResponseText = () => text(all(RESPONSE).at(-1)).slice(0, 400);
  const limitMessage = () => [lastResponseText(), ...all('[role="alert"],[role="status"]').map(text)].find(value => value && value.length < 600 && LIMIT.test(value)) || null;
  const generatedImages = () => [...new Set(all(IMAGE).filter(image => !image.closest('[role="dialog"],dialog') && image.complete && image.naturalWidth >= 256 && image.naturalHeight >= 256).map(image => image.currentSrc || image.src))];

  const inspect = () => ({ ok: true, url: location.href, conversationUrl: conversationURL(), composer: !!firstVisible(COMPOSER), loggedOut: loggedOut(), busy: busy(), turns: all(USER_TURN).length, limit: limitMessage() });

  const squash = value => value.replace(/\s+/g, ' ').trim();
  const matches = (box, value) => squash(box instanceof HTMLTextAreaElement ? box.value : box.innerText) === squash(value);
  const fill = async (box, value) => {
    box.focus();
    if (box instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, value);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, value);
      await sleep(200);
      if (!matches(box, value)) {
        const data = new DataTransfer();
        data.setData('text/plain', value);
        document.execCommand('selectAll', false);
        box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }
    }
    await sleep(400);
    return matches(box, value);
  };

  const composerScope = box => {
    for (let node = box.parentElement, depth = 0; node && node !== document.body && depth < 8; node = node.parentElement, depth++) {
      if (node.matches('form') || all('button', node).some(button => SEND_HINT.test(button.getAttribute('aria-label') || '') || button.type === 'submit')) return node;
    }
    return box.closest('form') || document;
  };
  const sendButton = box => {
    const known = firstVisible(SEND);
    if (ready(known)) return known;
    const label = button => `${button.getAttribute('aria-label') || ''} ${button.getAttribute('data-testid') || ''} ${button.id} ${button.title}`;
    const candidates = all('button', composerScope(box)).filter(button => visible(button) && ready(button) && !NOT_SEND.test(label(button)) && !button.hasAttribute('aria-haspopup'));
    return candidates.find(button => SEND_HINT.test(label(button))) || candidates.find(button => button.type === 'submit') || null;
  };
  const pressEnter = box => {
    box.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) box.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  };

  const submit = async message => {
    if (typeof message.jobId !== 'string' || typeof message.prompt !== 'string' || !message.prompt.trim()) throw fail('The prompt is empty.', 'GPT_INVALID_PROMPT');
    if (submittedJobs.has(message.jobId)) throw fail('This prompt was already sent in this tab.', 'GPT_ALREADY_SUBMITTED');
    if (loggedOut()) throw fail('Sign in to ChatGPT in the selected tab, then start again. Nothing was sent.', 'GPT_SIGNED_OUT');
    if (conversationURL() || all(USER_TURN).length) throw fail('The ChatGPT tab is not on a new, empty chat. Nothing was sent.', 'GPT_NOT_NEW_CHAT');
    if (busy()) throw fail('ChatGPT is still busy with another response. Nothing was sent.', 'GPT_BUSY');
    const box = await poll(() => firstVisible(COMPOSER), 8000);
    if (!box) throw fail('The ChatGPT message box was not found. Nothing was sent.', 'GPT_COMPOSER_NOT_FOUND');
    if (!await fill(box, message.prompt)) throw fail('The prompt could not be typed into ChatGPT exactly. Nothing was sent.', 'GPT_FILL_FAILED');
    const turns = all(USER_TURN).length;
    const sent = () => !!conversationURL() || all(USER_TURN).length > turns || !squash(box.isConnected ? (box instanceof HTMLTextAreaElement ? box.value : box.innerText) : '');
    submittedJobs.add(message.jobId);
    observed = { key: null, at: 0 };
    const button = await poll(() => sendButton(box), 15000);
    if (button) button.click();
    else pressEnter(box);
    if (!await poll(sent, button ? 8000 : 5000)) {
      if (button && matches(box, message.prompt)) pressEnter(box);
      if (!await poll(sent, 8000)) {
        const untouched = box.isConnected && matches(box, message.prompt) && !conversationURL() && all(USER_TURN).length === turns;
        if (untouched) submittedJobs.delete(message.jobId);
        throw fail(untouched ? 'ChatGPT did not accept the prompt. The text is still in its message box, so nothing was sent.' : 'The prompt may have been sent, but ChatGPT did not confirm it. Check the ChatGPT tab before sending again.', untouched ? 'GPT_SEND_FAILED' : 'GPT_SEND_UNCONFIRMED', { submitted: !untouched });
      }
    }
    const url = await poll(() => conversationURL(), 20000);
    return { ok: true, submitted: true, conversationUrl: url };
  };

  const status = () => {
    if (loggedOut()) return { ok: true, state: 'failed', code: 'GPT_SIGNED_OUT', detail: 'ChatGPT is signed out in the selected tab.' };
    const images = generatedImages();
    const working = busy();
    const key = `${working}|${all(USER_TURN).length}|${images.join('|')}|${lastResponseText().length}`;
    if (key !== observed.key) observed = { key, at: Date.now() };
    const settled = Date.now() - observed.at;
    const conversationUrl = conversationURL();
    if (!working && images.length && settled >= 3000) return { ok: true, state: 'ready', src: images[0], count: images.length, conversationUrl };
    if (!working && !images.length) {
      const limit = limitMessage();
      if (limit) return { ok: true, state: 'failed', code: 'GPT_LIMIT', detail: limit, conversationUrl };
      if (all(RESPONSE).length && settled >= 20000) return { ok: true, state: 'failed', code: 'GPT_NO_IMAGE', detail: lastResponseText() || 'ChatGPT finished without an image.', conversationUrl };
    }
    return { ok: true, state: 'waiting', conversationUrl, detail: working ? 'ChatGPT is generating the image.' : 'Waiting for the generated image to settle.' };
  };

  const toBase64 = blob => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const canvasBlob = src => {
    const image = all(IMAGE).find(element => (element.currentSrc || element.src) === src);
    if (!image?.naturalWidth) throw fail('The generated image is no longer on the page.', 'GPT_IMAGE_MISSING');
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(fail('The generated image could not be copied.', 'GPT_IMAGE_COPY')), 'image/png'));
  };
  const readImage = async message => {
    const src = message.src;
    if (typeof src !== 'string' || !generatedImages().includes(src)) throw fail('The generated image is no longer on the page.', 'GPT_IMAGE_MISSING');
    let blob = null;
    try {
      const response = await fetch(src, { credentials: 'include' });
      if (response.ok) blob = await response.blob();
    } catch {}
    if (!blob?.size) blob = await canvasBlob(src);
    if (blob.size > 20 * 1024 * 1024) throw fail('The generated image is larger than 20 MB.', 'GPT_IMAGE_TOO_LARGE');
    return { ok: true, type: blob.type, base64: await toBase64(blob) };
  };

  const handlers = { 'gpt:inspect': inspect, 'gpt:submit': submit, 'gpt:status': status, 'gpt:image': readImage };
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    const handler = handlers[message?.type];
    if (!handler || (sender.id && sender.id !== chrome.runtime.id)) return false;
    Promise.resolve().then(() => handler(message)).then(respond).catch(error => respond({ ok: false, error: String(error.message || error), code: error.code || 'GPT_ERROR', ...(message.type === 'gpt:submit' ? { submitted: error.submitted ?? submittedJobs.has(message.jobId) } : {}) }));
    return true;
  });
})();
