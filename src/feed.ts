import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { appDir, PortalBrowser } from './browser.js';
import { expandCalendar, EXPAND_DEFAULTS } from './ical.js';
import { ServiceError } from './shared.js';

export function feedUrl(value: string) {
  let url: URL;
  try { url = new URL(value.trim().replace(/^webcal:/i, 'https:')); }
  catch { throw invalidFeed(); }
  if (url.origin !== 'https://cloud.timeedit.net' || url.username || url.password ||
      !/^\/nl_tue\/web\/stud01\/.+\.ics$/i.test(url.pathname)) throw invalidFeed();
  return url;
}

const invalidFeed = () => new ServiceError('INVALID_FEED',
  'Use the .ics subscription address from TU/e TE Timetable → Personal schedule → Subscribe.');
const feedFile = join(appDir, 'timetable-feed');

export async function configuredFeed() {
  if (process.env.TUE_TIMETABLE_ICS) return feedUrl(process.env.TUE_TIMETABLE_ICS);
  try { return feedUrl(await readFile(feedFile, 'utf8')); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      throw new ServiceError('FEED_REQUIRED', 'Connect your personal TE Timetable subscription with npm run login -- timetable.');
    throw err;
  }
}

export async function saveFeed(url: URL) {
  await mkdir(appDir, { recursive: true, mode: 0o700 });
  const tmp = feedFile + '.' + randomUUID();
  try {
    await writeFile(tmp, url.href, { mode: 0o600, flag: 'wx' });
    await rename(tmp, feedFile);
  } finally { await rm(tmp, { force: true }); }
}

export async function readTimetable(url: URL, from: string, to: string) {
  const res = await fetch(feedUrl(url.href), { redirect: 'manual', signal: AbortSignal.timeout(25000) });
  if (!res.ok || !res.body) throw new ServiceError('FEED_UNAVAILABLE',
    'TimeEdit did not return the calendar. Check the subscription in your personal timetable.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > EXPAND_DEFAULTS.maxInputBytes)
      throw new ServiceError('FILE_TOO_LARGE', 'This calendar exceeds the 4 MiB limit.');
    chunks.push(chunk);
  }
  const ics = Buffer.concat(chunks).toString('utf8');
  if (!/^BEGIN:VCALENDAR\s*$/im.test(ics) || !/^END:VCALENDAR\s*$/im.test(ics)) throw invalidFeed();
  return expandCalendar(ics, from, to, { maxItems: 500 });
}

export function schedulePage(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw invalidFeed(); }
  if (url.origin !== 'https://cloud.timeedit.net' || url.username || url.password ||
    !/^\/nl_tue\/web\/stud01\/(?:[\w.-]+\.html)?$/.test(url.pathname))
    throw new ServiceError('INVALID_TIMETABLE_PAGE', 'Use the TU/e student schedule page on cloud.timeedit.net.');
  return url;
}

/** Follow the subscription link rendered by the authenticated schedule itself. */
export async function feedFromPage(browser: PortalBrowser, pageAddress: string) {
  const target = schedulePage(pageAddress);
  const page = await browser.open(target.href);
  const timeout = browser.interactive ? 30 * 60_000 : 15000;
  const login = page.locator('#loginForm #loginAuth');
  if (await page.locator('#loginForm').count()) {
    // TimeEdit tries silent SSO first and reveals Login asynchronously when it needs a click.
    await page.waitForFunction(() => !document.querySelector('#loginForm') ||
      !!document.querySelector('#loginAuth')?.getClientRects().length, undefined, { timeout: 25000 });
  }
  if (new URL(page.url()).origin === target.origin && await login.isVisible()) {
    if (!browser.interactive) throw new ServiceError('TIMETABLE_SIGN_IN', 'Use npm run login -- timetable to connect TimeEdit.');
    // Open TimeEdit's normal university sign-in route. Password and MFA entry stay with the user.
    await login.click();
    await page.waitForFunction(() => location.origin === 'https://cloud.timeedit.net' &&
      !document.querySelector('#loginForm') && !!document.body?.innerText.trim(), undefined, { timeout });
    if (new URL(page.url()).pathname !== target.pathname) {
      await page.goto(target.href, { waitUntil: 'domcontentloaded' });
    }
  }
  if (target.pathname.endsWith('/')) {
    const personal = page.getByRole('link', { name: /personal (schedule|timetable)|persoonlijk rooster|mijn rooster/i }).first();
    try { await personal.waitFor({ timeout }); }
    catch { throw new ServiceError('TIMETABLE_SIGN_IN', 'Sign in to TimeEdit and open Personal schedule, or set TUE_TIMETABLE_URL to that page.'); }
    const href = await personal.getAttribute('href');
    if (!href) throw invalidFeed();
    await page.goto(schedulePage(new URL(href, page.url()).href).href, { waitUntil: 'domcontentloaded' });
  }
  const link = page.locator('a.icalsublink[href*=".ics"], input.icalurl').first();
  try { await link.waitFor({ state: 'attached', timeout }); }
  catch { throw new ServiceError('TIMETABLE_SIGN_IN', 'Open the personal schedule in the MCP browser and finish TimeEdit sign-in.'); }
  schedulePage(page.url());
  const value = await link.evaluate(el => el instanceof HTMLInputElement ? el.value : (el as HTMLAnchorElement).href);
  return feedUrl(value);
}
