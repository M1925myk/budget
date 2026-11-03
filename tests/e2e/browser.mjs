// Минимальный клиент Chrome DevTools Protocol без внешних библиотек.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_PATH = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

class Session {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => this.onMessage(JSON.parse(event.data)));
  }

  onMessage(message) {
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject, method } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
      return;
    }
    for (const handler of this.listeners.get(message.method) ?? []) handler(message.params, message.sessionId);
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }
}

export class Page {
  constructor(session, sessionId) {
    this.session = session;
    this.sessionId = sessionId;
    this.consoleErrors = [];
    this.exceptions = [];
    this.requests = [];
    session.on('Runtime.exceptionThrown', (params, sid) => {
      if (sid === sessionId) this.exceptions.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
    });
    session.on('Runtime.consoleAPICalled', (params, sid) => {
      if (sid === sessionId && params.type === 'error') {
        this.consoleErrors.push(params.args.map((arg) => arg.value ?? arg.description).join(' '));
      }
    });
    session.on('Log.entryAdded', (params, sid) => {
      if (sid === sessionId && params.entry.level === 'error') this.consoleErrors.push(params.entry.text);
    });
    session.on('Network.requestWillBeSent', (params, sid) => {
      if (sid === sessionId) this.requests.push({ url: params.request.url, method: params.request.method, hasBody: Boolean(params.request.hasPostData) });
    });
  }

  send(method, params) {
    return this.session.send(method, params, this.sessionId);
  }

  async enable() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
    await this.send('Log.enable');
  }

  async viewport({ width = 430, height = 932, scale = 3 } = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: true });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }

  /** Вырез и полоска «Домой» iPhone 15 Pro Max. Старые версии Chrome этого не умеют — тогда отступы нулевые. */
  async safeArea(top = 59, bottom = 34) {
    try {
      await this.send('Emulation.setSafeAreaInsetsOverride', { insets: { top, bottom, left: 0, right: 0 } });
    } catch {
      this.noSafeArea = true;
    }
  }

  async navigate(url) {
    const loaded = new Promise((resolve) => {
      const handler = (params, sid) => {
        if (sid === this.sessionId) resolve();
      };
      this.session.on('Page.loadEventFired', handler);
    });
    const result = await this.send('Page.navigate', { url });
    if (result.errorText) throw new Error(`Не открылось ${url}: ${result.errorText}`);
    await loaded;
    await this.evaluate('new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)))');
  }

  reload(url) {
    return this.navigate(url);
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (exceptionDetails) {
      throw new Error(`evaluate: ${exceptionDetails.exception?.description ?? exceptionDetails.text}\n${expression}`);
    }
    return result.value;
  }

  async waitFor(expression, timeoutMs = 5000) {
    const started = Date.now();
    for (;;) {
      if (await this.evaluate(expression)) return;
      if (Date.now() - started > timeoutMs) throw new Error(`Не дождался: ${expression}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }

  text(selector) {
    return this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  }

  exists(selector) {
    return this.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  }

  visible(selector) {
    return this.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== 'hidden'; })()`);
  }

  /** Настоящее нажатие по координатам: проверяет, что элемент видим и его ничего не перекрывает. */
  async click(selector) {
    const point = await this.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return { error: 'нет элемента' };
      node.scrollIntoView({ block: 'center' });
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return { error: 'элемент скрыт' };
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === node || node.contains(hit))) return { error: 'перекрыт элементом ' + (hit ? hit.tagName + '#' + hit.id + '.' + hit.className : 'null') };
      return { x, y };
    })()`);
    if (point.error) throw new Error(`Нажатие на ${selector}: ${point.error}`);
    // Человек не нажимает второй раз в ту же точку быстрее полсекунды, а такое нажатие приложение
    // считает случайным двойным касанием. Сценарии двойного касания шлют события напрямую.
    this.recentClicks = (this.recentClicks ?? []).filter((c) => Date.now() - c.time < 550);
    const nearby = this.recentClicks.filter((c) => Math.hypot(point.x - c.x, point.y - c.y) < 50);
    if (nearby.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 550 - (Date.now() - nearby[0].time)));
    }
    this.recentClicks.push({ x: point.x, y: point.y, time: Date.now() });
    const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
    await this.evaluate('new Promise((r) => setTimeout(r, 20))');
  }

  async type(selector, value) {
    await this.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); n.focus(); n.select?.(); })()`);
    if (value === '') {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      return;
    }
    await this.send('Input.insertText', { text: value });
  }

  setValue(selector, value) {
    return this.evaluate(`(() => {
      const n = document.querySelector(${JSON.stringify(selector)});
      n.value = ${JSON.stringify(value)};
      n.dispatchEvent(new Event('input', { bubbles: true }));
      n.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  }

  async screenshot() {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(data, 'base64');
  }
}

export async function launchChrome() {
  const userDataDir = mkdtempSync(join(process.env.E2E_TMP ?? tmpdir(), 'chrome-profile-'));
  const chrome = spawn(CHROME_PATH, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-extensions',
    '--metrics-recording-only',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error(`Chrome не запустился:\n${log}`)), 20_000);
    chrome.stderr.on('data', (chunk) => {
      log += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(log);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    chrome.on('exit', (code) => reject(new Error(`Chrome завершился с кодом ${code}:\n${log}`)));
  });

  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const session = new Session(socket);

  return {
    /** Страница в отдельном профиле: своё хранилище, service worker и кэш. */
    async newPage({ init } = {}) {
      const { browserContextId } = await session.send('Target.createBrowserContext');
      const { targetId } = await session.send('Target.createTarget', { url: 'about:blank', browserContextId });
      const { sessionId } = await session.send('Target.attachToTarget', { targetId, flatten: true });
      const page = new Page(session, sessionId);
      page.browserContextId = browserContextId;
      await page.enable();
      if (init) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: init });
      return page;
    },
    async close() {
      socket.close();
      const exited = new Promise((resolve) => chrome.once('exit', resolve));
      chrome.kill('SIGKILL');
      await exited;
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}
