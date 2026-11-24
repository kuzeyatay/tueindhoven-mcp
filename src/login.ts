import type { Page } from 'playwright-core';
import { PortalBrowser } from './browser.js';
import { canvasOrigin, planOrigin, studentOrigin, timetableEntry, ServiceError } from './shared.js';
import { configuredFeed, feedFromPage, feedUrl, readTimetable, saveFeed } from './feed.js';

export const loginSites = {
  canvas: { url: canvasOrigin, ready: '#global_nav_profile_link' },
  osiris: { url: studentOrigin, ready: 'page-home, page-grades, page-progress' },
  planapp: { url: planOrigin, ready: 'pa-plan-page' },
};
const minutes = 30 * 60_000;

async function connectCalendar(browser: PortalBrowser) {
  const context = await browser.context();
  await browser.open(timetableEntry);
  const entry = await context.newPage();
  // This form lives only in an empty browser tab and never submits over the network.
  await entry.setContent(`<meta charset="utf-8"><meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'">
    <title>Connect TE Timetable</title><style>body{max-width:38em;margin:10vh auto;font:18px system-ui}
    input,button{padding:.6em;font:inherit}input{width:95%;margin:1em 0}</style>
    <h1>Connect your TU/e timetable</h1><p>Open the TimeEdit tab, sign in and choose
    <b>Personal schedule</b>. Copy the page address here. You can also paste the iCalendar
    address from <b>Subscribe</b>.</p>
    <label for="feed">Personal schedule or iCalendar address</label>
    <input type="password" id="feed" autocomplete="off"><button>Connect</button><p role="status"></p>`);
  await entry.bringToFront();
  await entry.locator('button').evaluate(el => el.addEventListener('click', () => {
    document.body.dataset.submitted = 'yes';
  }));
  while (!entry.isClosed()) {
    await entry.locator('body[data-submitted="yes"]').waitFor({ timeout: minutes });
    const value = await entry.locator('input').inputValue();
    await entry.evaluate(() => { delete document.body.dataset.submitted; });
    try {
      const url = /\.html(?:[?#]|$)/i.test(value) ? await feedFromPage(browser, value) : feedUrl(value);
      const now = Date.now();
      await readTimetable(url, new Date(now).toISOString(), new Date(now + 86400000).toISOString());
      await saveFeed(url);
    } catch {
      await entry.bringToFront();
      await entry.getByRole('status').evaluate(el => {
        el.textContent = 'Could not read this calendar. Check the address and try again.';
      });
      continue;
    }
    await entry.close();
    return;
  }
  throw new ServiceError('LOGIN_CANCELLED', 'Timetable setup closed.');
}

export async function login(browser: PortalBrowser, only?: string) {
  const names = only ? [only] : ['canvas', 'osiris', 'planapp', 'timetable'];
  for (const name of names) {
    console.error(`Connecting ${name}…`);
    if (name === 'timetable') {
      if (process.env.TUE_TIMETABLE_URL) {
        const url = await feedFromPage(browser, process.env.TUE_TIMETABLE_URL);
        await readTimetable(url, new Date().toISOString(), new Date(Date.now() + 86400000).toISOString());
        await saveFeed(url);
      } else {
        try { await configuredFeed(); } catch { await connectCalendar(browser); }
      }
      continue;
    }
    if (!Object.hasOwn(loginSites, name)) throw new ServiceError('INVALID_ARGUMENT', 'Choose canvas, osiris, planapp or timetable.');
    if (name === 'canvas' && process.env.TUE_CANVAS_TOKEN) continue;
    const site = loginSites[name as keyof typeof loginSites];
    const page: Page = await browser.open(site.url);
    await page.locator(site.ready).first().waitFor({ state: 'attached', timeout: minutes });
    if (new URL(page.url()).origin !== site.url) throw new ServiceError('LOGIN_INCOMPLETE', 'Sign-in did not return to the university portal.');
    console.error(`${name} sign-in recognized.`);
  }
}
