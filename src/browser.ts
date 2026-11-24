import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { ServiceError, TIMEZONE } from './shared.js';

export const appDir = join(homedir(), '.tueindhoven-mcp');

export function executable() {
  const candidates = process.platform === 'win32'
    ? [join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
       join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
       join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')]
    : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
       '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
       '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const path = [process.env.TUE_BROWSER_PATH, ...candidates, chromium.executablePath()]
    .find(p => p && existsSync(p));
  if (!path) throw new ServiceError('BROWSER_NOT_FOUND', 'Install Edge or Chrome, or set TUE_BROWSER_PATH.');
  return path;
}

export class PortalBrowser {
  private started?: Promise<BrowserContext>;
  constructor(readonly interactive = false) {}

  context(): Promise<BrowserContext> {
    this.started ??= this.launch().catch(error => {
      this.started = undefined;
      throw error;
    });
    return this.started;
  }

  private async launch() {
    const executablePath = executable();
    await mkdir(appDir, { recursive: true, mode: 0o700 });
    try {
      return await chromium.launchPersistentContext(join(appDir, 'profile'), {
        executablePath, headless: !this.interactive, timezoneId: TIMEZONE, locale: 'en-GB',
        viewport: this.interactive ? null : { width: 1440, height: 1000 },
        acceptDownloads: false, args: ['--restore-last-session', '--no-default-browser-check'],
        ignoreDefaultArgs: ['--password-store=basic'],
      });
    } catch {
      throw new ServiceError('BROWSER_UNAVAILABLE', 'Could not open the dedicated browser. Close another tueindhoven-mcp browser or server using this profile and retry.');
    }
  }

  async open(url: string): Promise<Page> {
    const context = await this.context();
    const target = new URL(url);
    const existing = context.pages().find(page => {
      const current = new URL(page.url());
      return current.origin === target.origin && current.pathname === target.pathname;
    });
    const page = existing || context.pages().find(p => new URL(p.url()).origin === target.origin)
      || await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (this.interactive) await page.bringToFront();
    return page;
  }

  async close() {
    await (await this.started)?.close();
    this.started = undefined;
  }
}
