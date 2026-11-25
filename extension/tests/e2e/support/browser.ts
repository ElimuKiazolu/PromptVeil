/**
 * Headless Chrome with the e2e build loaded, pointed at the local copy
 * (chatgpt.com and other.test resolve to 127.0.0.1). Collects every console
 * line of the pages and of the extension's service worker, and drives tabs
 * the way a user would (keyboard and clicks).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, {
  type Browser,
  type Page,
  TargetType,
  type SerializedAXNode,
  type Target,
  type WebWorker,
} from 'puppeteer-core';
import type { PageApi, PageRequest, RequestOutcome } from './page.ts';
import { OTHER_HOST, SITE_HOST, type Site } from './site.ts';

export const EDITOR = 'form[data-chatgpt-composer] [contenteditable="true"]';
const MESSAGE_PATH = '/backend-api/f/conversation';

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type Missing = null | undefined | false;

/** Polls `probe` until it returns a value (not null, undefined or false). */
export async function waitFor<T>(
  probe: () => T | Missing | Promise<T | Missing>,
  timeout: number,
  what: string,
): Promise<T> {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Chrome's path: CHROME_PATH, else the usual install locations. */
export function findChrome(): string {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv) return fromEnv;
  const env = (name: string): string => process.env[name] ?? '';
  const candidates =
    process.platform === 'win32'
      ? [
          join(env('ProgramFiles'), 'Google/Chrome/Application/chrome.exe'),
          join(
            env('ProgramFiles(x86)'),
            'Google/Chrome/Application/chrome.exe',
          ),
          join(env('LOCALAPPDATA'), 'Google/Chrome/Application/chrome.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
          ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error('Chrome not found: set CHROME_PATH');
  return found;
}

export interface LogLine {
  readonly source: 'page' | 'worker';
  readonly text: string;
  readonly at: number;
}

export class LogBook {
  readonly lines: LogLine[] = [];

  add(source: LogLine['source'], text: string): void {
    this.lines.push({ source, text, at: Date.now() });
  }

  /** A position to read from later (`since`). */
  mark(): number {
    return this.lines.length;
  }

  since(mark: number, source?: LogLine['source']): LogLine[] {
    return this.lines
      .slice(mark)
      .filter((line) => source === undefined || line.source === source);
  }

  /** Matching lines after `mark`. */
  matching(pattern: RegExp, mark = 0, source?: LogLine['source']): LogLine[] {
    return this.since(mark, source).filter((line) => pattern.test(line.text));
  }

  waitFor(
    pattern: RegExp,
    mark: number,
    timeout = 10_000,
    source?: LogLine['source'],
  ): Promise<LogLine> {
    return waitFor(
      () => this.matching(pattern, mark, source)[0],
      timeout,
      `log ${pattern.source}`,
    );
  }
}

/** Number after `name=` in a dev-log line. */
export function field(line: string, name: string): number | null {
  const match = new RegExp(`(?:^| )${name}=([\\d.]+)`).exec(line);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** A notice as the accessibility tree presents it. */
export interface Notice {
  /** Its accessible name (the title); '(status)' for the live region. */
  readonly title: string;
  /** All text inside it. */
  readonly text: string;
}

export interface SendResult {
  /** The message text the site received. */
  readonly received: string;
  /** ms from Enter to the site receiving the request. */
  readonly ms: number;
}

export class Tab {
  readonly page: Page;
  private readonly site: Site;

  constructor(page: Page, site: Site) {
    this.page = page;
    this.site = site;
  }

  async front(): Promise<void> {
    await this.page.bringToFront();
  }

  url(): URL {
    return new URL(this.page.url());
  }

  conversationId(): string | null {
    return /^\/c\/([A-Za-z0-9-]+)/.exec(this.url().pathname)?.[1] ?? null;
  }

  async newChat(): Promise<void> {
    await this.front();
    await this.page.click('#new-chat');
    await waitFor(() => this.url().pathname === '/', 5_000, 'new chat');
  }

  async type(text: string): Promise<void> {
    await this.front();
    await this.page.focus(EDITOR);
    await this.page.keyboard.type(text);
  }

  editorText(): Promise<string> {
    return this.page.$eval(EDITOR, (el) => el.textContent);
  }

  /**
   * Types `prompt` and presses Enter after a typing pause; resolves with the
   * message the site received. A new chat waits for its ID in the URL.
   */
  async send(
    prompt: string,
    options: { newChat?: boolean } = {},
  ): Promise<SendResult> {
    if (options.newChat === true) await this.newChat();
    const before = this.site.requests.length;
    await this.type(prompt);
    await sleep(500);
    const started = Date.now();
    await this.page.keyboard.press('Enter');
    const request = await waitFor(
      () =>
        this.site.requests
          .slice(before)
          .find((r) => r.method === 'POST' && r.url === MESSAGE_PATH),
      20_000,
      'message request',
    );
    const body = JSON.parse(request.body) as {
      messages: { content: { parts: string[] } }[];
    };
    const received = body.messages[0]?.content.parts[0] ?? '';
    if (options.newChat === true) {
      await waitFor(() => this.conversationId(), 10_000, 'conversation id');
    }
    return { received, ms: request.at - started };
  }

  /** Presses Enter on `prompt` and confirms no message request follows. */
  async sendBlocked(prompt: string, wait = 3_000): Promise<void> {
    const before = this.site.requests.length;
    await this.type(prompt);
    await sleep(500);
    await this.page.keyboard.press('Enter');
    await sleep(wait);
    const sent = this.site.requests
      .slice(before)
      .some((r) => r.method === 'POST' && r.url === MESSAGE_PATH);
    if (sent) throw new Error('a message request reached the site');
  }

  /** Presses Enter in the editor as it is; no message request may follow. */
  async pressEnterBlocked(wait = 2_000): Promise<void> {
    const before = this.site.requests.length;
    await this.front();
    await this.page.focus(EDITOR);
    await this.page.keyboard.press('Enter');
    await sleep(wait);
    const sent = this.site.requests
      .slice(before)
      .some((r) => r.method === 'POST' && r.url === MESSAGE_PATH);
    if (sent) throw new Error('a message request reached the site');
  }

  text(): Promise<string> {
    return this.page.evaluate(() => document.body.innerText);
  }

  /** Waits until the page shows every one of `parts`. */
  async waitForText(parts: readonly string[], timeout = 15_000): Promise<void> {
    const until = Date.now() + timeout;
    for (;;) {
      const text = await this.text();
      // Positions only: the parts are real values.
      const missing = parts.flatMap((part, i) =>
        text.includes(part) ? [] : [`#${(i + 1).toString()}`],
      );
      if (missing.length === 0) return;
      if (Date.now() > until) {
        throw new Error(
          `page does not show expected value ${missing.join(', ')} of ${parts.length.toString()}`,
        );
      }
      await sleep(100);
    }
  }

  /** Clicks the sidebar link of a conversation (client-side navigation). */
  async openConversation(id: string): Promise<void> {
    await this.front();
    await waitFor(
      () => this.page.$(`a[data-conv="${id}"]`),
      5_000,
      'sidebar link',
    );
    await this.page.click(`a[data-conv="${id}"]`);
    await waitFor(() => this.conversationId() === id, 5_000, 'conversation');
  }

  cardSaves(): Promise<number> {
    return this.page.evaluate(
      () => (Reflect.get(window, '__pv') as PageApi).cardSaves.length,
    );
  }

  /** Types into the writing card; resolves with the save it causes. */
  async typeInCard(text: string): Promise<string> {
    await this.front();
    const before = await this.cardSaves();
    await this.page.click('[data-card]');
    await this.page.keyboard.press('End');
    await this.page.keyboard.type(text);
    await waitFor(
      async () => (await this.cardSaves()) > before,
      15_000,
      'card save',
    );
    return this.page.evaluate(
      () => (Reflect.get(window, '__pv') as PageApi).cardSaves.at(-1) ?? '',
    );
  }

  /** Starts typing into the writing card (no waiting for its save). */
  async startTypingInCard(text: string): Promise<void> {
    await this.front();
    await this.page.click('[data-card]');
    await this.page.keyboard.press('End');
    await this.page.keyboard.type(text);
  }

  /** Renames the chat with the copy's sidebar control; 'saved' or 'failed'. */
  async rename(title: string): Promise<string> {
    await this.front();
    const count = (): Promise<number> =>
      this.page.evaluate(
        () => (Reflect.get(window, '__pv') as PageApi).renames.length,
      );
    const before = await count();
    await this.page.click('#rename-input', { count: 3 });
    await this.page.keyboard.type(title);
    await this.page.click('#rename-save');
    await waitFor(async () => (await count()) > before, 15_000, 'rename');
    return this.page.evaluate(
      () => (Reflect.get(window, '__pv') as PageApi).renames.at(-1) ?? '',
    );
  }

  /**
   * The notices the extension shows, read through the accessibility tree
   * (as assistive technology reads them; their shadow root is closed).
   */
  async notices(): Promise<Notice[]> {
    const tree = await this.page.accessibility.snapshot({
      interestingOnly: false,
    });
    const found: Notice[] = [];
    const textOf = (node: SerializedAXNode): string =>
      [node.name ?? '', ...(node.children ?? []).map(textOf)]
        .filter((part) => part !== '')
        .join(' ');
    const walk = (node: SerializedAXNode | null): void => {
      if (node === null) return;
      if (node.role === 'region' && node.name !== undefined) {
        found.push({ title: node.name, text: textOf(node) });
        return;
      }
      if (node.role === 'status') {
        found.push({ title: '(status)', text: textOf(node) });
        return;
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
    return found;
  }

  request(request: PageRequest): Promise<RequestOutcome> {
    return this.page.evaluate(
      (r) => (Reflect.get(window, '__pv') as PageApi).request(r),
      request,
    );
  }

  pageshows(): Promise<boolean[]> {
    return this.page.evaluate(() => [
      ...(Reflect.get(window, '__pv') as PageApi).pageshows,
    ]);
  }

  async reload(): Promise<void> {
    await this.front();
    await this.page.reload({ waitUntil: 'load' });
  }

  isClosed(): boolean {
    return this.page.isClosed();
  }

  close(): Promise<void> {
    return this.page.close();
  }
}

export interface Harness {
  readonly site: Site;
  readonly browser: Browser;
  readonly logs: LogBook;
  readonly extensionDir: string;
  extensionId(): string;
  /** Opens a tab on `path` and waits until the extension is ready there. */
  openTab(path?: string): Promise<Tab>;
  /** Opens a tab on another site (no content script). */
  openOtherSite(): Promise<Page>;
  /** The extension's running service worker (woken if stopped). */
  worker(): Promise<WebWorker>;
  /** Stops the service worker and waits until it is gone. */
  stopWorker(): Promise<void>;
  /** Reloads the extension in place (open tabs keep the old instance). */
  reloadExtension(): Promise<void>;
  close(): Promise<void>;
}

export interface LaunchOptions {
  /** A profile that outlives the browser (restart checks); else a fresh one. */
  readonly userDataDir?: string;
  /** Collects the console lines here (e.g. the main harness's log book). */
  readonly logs?: LogBook;
}

export async function launch(
  site: Site,
  extensionDir: string,
  options: LaunchOptions = {},
): Promise<Harness> {
  const logs = options.logs ?? new LogBook();
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    pipe: true,
    enableExtensions: [extensionDir],
    ...(options.userDataDir === undefined
      ? {}
      : { userDataDir: options.userDataDir }),
    args: [
      `--host-resolver-rules=MAP ${SITE_HOST}:443 127.0.0.1:${site.port.toString()}, MAP ${OTHER_HOST}:443 127.0.0.1:${site.port.toString()}`,
      '--ignore-certificate-errors',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  let extensionId = '';
  let stops = 0;
  const workers = new Map<Target, WebWorker>();
  const isOurWorker = (target: Target): boolean =>
    target.type() === TargetType.SERVICE_WORKER &&
    target.url().startsWith('chrome-extension://') &&
    target.url().endsWith('/background.js');
  const attach = async (target: Target): Promise<void> => {
    if (!isOurWorker(target) || workers.has(target)) return;
    extensionId = new URL(target.url()).host;
    const worker = await target.worker();
    if (!worker) return;
    workers.set(target, worker);
    worker.on('console', (message) => {
      logs.add('worker', message.text());
    });
  };
  browser.on('targetcreated', (target: Target) => {
    void attach(target);
  });
  browser.on('targetdestroyed', (target: Target) => {
    workers.delete(target);
  });
  for (const target of browser.targets()) await attach(target);
  await waitFor(() => extensionId || null, 20_000, 'extension service worker');

  const openPage = async (): Promise<Page> => {
    const page = await browser.newPage();
    page.on('console', (message) => {
      logs.add('page', message.text());
    });
    return page;
  };

  const harness: Harness = {
    site,
    browser,
    logs,
    extensionDir,
    extensionId: () => extensionId,
    async openTab(path = '/') {
      const page = await openPage();
      const mark = logs.mark();
      await page.goto(`https://${SITE_HOST}${path}`, { waitUntil: 'load' });
      await logs.waitFor(/ warmup\.done/, mark, 30_000, 'page');
      return new Tab(page, site);
    },
    async openOtherSite() {
      const page = await openPage();
      await page.goto(`https://${OTHER_HOST}/`, { waitUntil: 'load' });
      return page;
    },
    async worker() {
      const running = [...workers.values()][0];
      if (running) return running;
      // Opening an extension page wakes the worker.
      const page = await browser.newPage();
      await page.goto(`chrome-extension://${extensionId}/popup.html`);
      await page.close();
      return waitFor(() => [...workers.values()][0], 10_000, 'worker');
    },
    async stopWorker() {
      const session = await browser.target().createCDPSession();
      try {
        // Marks the running instance, so a fresh start (an open tab may
        // wake the worker again at once) is told apart from it.
        stops += 1;
        const mark = `stop-${stops.toString()}`;
        for (const worker of workers.values()) {
          await worker.evaluate((m) => {
            Reflect.set(globalThis, '__e2eStopMark', m);
          }, mark);
        }
        // A debugger session on the worker keeps it alive; drop ours first.
        for (const [target, worker] of workers) {
          workers.delete(target);
          await worker.close();
        }
        const { targetInfos } = await session.send('Target.getTargets');
        for (const info of targetInfos) {
          if (
            info.type === 'service_worker' &&
            info.url === `chrome-extension://${extensionId}/background.js`
          ) {
            // Closing our worker session may already be stopping it; a
            // target that is gone by now is the outcome we want.
            await session
              .send('Target.closeTarget', { targetId: info.targetId })
              .catch((error: unknown) => {
                const gone =
                  error instanceof Error &&
                  error.message.includes('No target with given id found');
                if (!gone) throw error;
              });
          }
        }
        // Stopped: no worker runs, or the one running started afresh.
        await waitFor(
          async () => {
            const { targetInfos: now } =
              await session.send('Target.getTargets');
            const running = now.some(
              (info) =>
                info.type === 'service_worker' &&
                info.url.startsWith(`chrome-extension://${extensionId}/`),
            );
            if (!running) return true;
            const fresh = [...workers.values()][0];
            if (fresh === undefined) return false;
            const seen = await fresh.evaluate((): unknown =>
              Reflect.get(globalThis, '__e2eStopMark'),
            );
            return seen !== mark;
          },
          10_000,
          'worker to stop',
        );
      } finally {
        await session.detach();
      }
    },
    async reloadExtension() {
      const id = await browser.installExtension(extensionDir);
      if (id !== extensionId) throw new Error('extension id changed on reload');
      await waitFor(() => [...workers.values()][0], 20_000, 'new worker');
    },
    close: () => browser.close(),
  };
  return harness;
}
