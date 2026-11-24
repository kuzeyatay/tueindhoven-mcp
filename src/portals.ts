import type { PortalBrowser } from './browser.js';
import { studentOrigin, planOrigin, ServiceError, authRequired } from './shared.js';

const views = {
  grades: { origin: studentOrigin, path: '/resultaten', root: 'page-grades', row: 'osi-grade-item' },
  progress: { origin: studentOrigin, path: '/voortgang', root: 'page-progress', row: 'osi-progress-exam-stage-card' },
  plan: { origin: planOrigin, path: '/plan', root: 'pa-plan-page', row: 'pa-plan-grid-year' },
};

export async function portalView(browser: PortalBrowser, view: keyof typeof views) {
  const { origin, path, root, row } = views[view];
  const page = await browser.open(origin + path);
  const timeout = 25000;
  const scope = page.locator(root + ':visible').first();
  try {
    if (origin === studentOrigin) {
      // A renewed OSIRIS session may land at Home before honoring a deep link.
      await page.locator(root + ':visible, page-home:visible').first().waitFor({ timeout });
      if (await page.locator('page-home:visible').count())
        await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
    }
    await scope.waitFor({ timeout });
    await page.waitForFunction(({ root, row }) => {
      const visibleRoot = [...document.querySelectorAll<HTMLElement>(root)].find(el => el.getClientRects().length);
      if (!visibleRoot) return false;
      const rows = Array.from(visibleRoot.querySelectorAll<HTMLElement>(row));
      return rows.some(el => el.innerText?.trim()) ||
        /no (?:study |exam |course )?(?:results|data|programmes|plans)|geen (?:studie)?(?:resultaten|gegevens|opleidingen|plannen)/i.test(visibleRoot.innerText);
    }, { root, row }, { timeout });
  } catch {
    const current = new URL(page.url());
    if (current.origin !== origin || /login|session/i.test(current.pathname)) throw authRequired(view === 'plan' ? 'PlanApp' : 'OSIRIS');
    throw new ServiceError('VIEW_UNAVAILABLE', 'The expected personal records or an explicit empty state did not load.');
  }
  if (new URL(page.url()).origin !== origin) throw authRequired('the university portal');
  const items = (await scope.locator(row).allInnerTexts()).map(text => text.trim()).filter(Boolean);
  return { view, items, scope: 'Records rendered in the current portal view', empty: items.length === 0,
    summary: (await scope.innerText()).trim().slice(0, 20000) };
}
