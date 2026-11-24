import { createHash, randomUUID } from 'node:crypto';
import type { ElementHandle, Frame, Page } from 'playwright-core';
import type { PortalBrowser } from './browser.js';
import { PreviewStore } from './previews.js';
import { canvasOrigin, planOrigin, studentOrigin, ServiceError } from './shared.js';

export const roles = ['button','link','textbox','searchbox','spinbutton','radio','checkbox',
  'combobox','option','tab','switch','menuitem'] as const;
type Role = typeof roles[number];
type Area = 'osiris_registration' | 'planapp' | 'new_quiz';
type Action = { frame: number; role: Role; name: string; occurrence?: number;
  action: 'click' | 'fill' | 'select'; value?: string };
type Open = { area: Area; courseId?: string; assignmentId?: string };
type Pending = { kind: 'open'; dest: Open } | {
  kind: 'form'; frame: Frame; url: string; element: ElementHandle<HTMLElement | SVGElement>;
  command: Action; fingerprint: string;
};

function allowed(area: Area, value: string) {
  const u = new URL(value);
  if (area === 'planapp') return u.origin === planOrigin && /^\/(plan|catalog|curriculum)(\/|$)/.test(u.pathname);
  if (area === 'osiris_registration') return u.origin === studentOrigin && /^\/(inschrijven|onderwijscatalogus)(\/|$)/.test(u.pathname);
  return (u.origin === canvasOrigin && /^\/courses\/\d+\/assignments\/\d+\/?$/.test(u.pathname))
    || (u.protocol === 'https:' && /^(?:[\w-]+\.)*quiz-lti-[\w-]+\.instructure\.com$/.test(u.hostname));
}

/** Operations use visible controls on an institution page and never accept JavaScript, selectors or arbitrary URLs. */
export class Workflows {
  private page?: Page;
  private area?: Area;
  private session = randomUUID();
  private previews = new PreviewStore();
  constructor(private browser: PortalBrowser) {}

  prepareOpen(dest: Open) {
    if (dest.area === 'new_quiz' && (!dest.courseId || !dest.assignmentId))
      throw new ServiceError('INVALID_ARGUMENT', 'Supply the course and New Quiz assignment IDs.');
    const p = this.previews.create<Pending>('view', this.session, { kind: 'open', dest });
    return { ...dest, confirmationToken: p.token, expiresAt: p.expiresAt,
      consequence: dest.area === 'new_quiz' ? 'Open the Canvas assignment and its learner assessment. The assessment may start a timer.' : 'Open the signed-in portal form.' };
  }

  private frames() {
    if (!this.page || !this.area || this.page.isClosed() || !allowed(this.area, this.page.url()))
      throw new ServiceError('VIEW_UNAVAILABLE', 'Open a university form first or finish signing in.');
    return this.page.frames().filter(f => allowed(this.area!, f.url()));
  }

  async view() {
    const frames = this.frames();
    return { area: this.area, frames: await Promise.all(frames.map(async (f, i) => {
      // URL lines may contain personal or signed addresses. Control names suffice to act.
      const snapshot = (await f.locator('body').ariaSnapshot()).split('\n').filter(line => !/^\s*-?\s*\/url:/.test(line)).join('\n');
      return { frame: i, content: snapshot.slice(0, 45000), truncated: snapshot.length > 45000 };
    })) };
  }

  private async describe(el: ElementHandle<HTMLElement | SVGElement>) {
    const context = await el.evaluate(e => {
      if (!e.isConnected || !e.getClientRects().length) return null;
      const input = e as HTMLInputElement;
      const href = e.closest('a[href]')?.getAttribute('href');
      return { tag: e.tagName, text: e.textContent?.trim().slice(0, 500), ariaLabel: e.getAttribute('aria-label'),
        type: input.type, href: href ? new URL(href, document.baseURI).href : undefined,
        question: e.closest('fieldset, [role="radiogroup"], .question')?.textContent?.trim().slice(0, 700),
        current: ['INPUT','TEXTAREA','SELECT'].includes(e.tagName) && !['password','hidden','file'].includes(input.type) ? input.value : undefined };
    });
    if (!context || ['password','hidden','file'].includes(context.type) || (context.href && !allowed(this.area!, context.href)))
      throw new ServiceError('UNSUPPORTED_CONTROL', 'Choose a visible control inside the selected portal workflow.');
    return createHash('sha256').update(JSON.stringify(context)).digest('hex');
  }

  async prepare(command: Action) {
    const frame = this.frames()[command.frame];
    if (!frame) throw new ServiceError('STALE_VIEW', 'Read the current form again.');
    if ((command.action === 'click') !== (command.value === undefined))
      throw new ServiceError('INVALID_ARGUMENT', 'Supply a value for fill or select only.');
    const matches = frame.getByRole(command.role, { name: command.name, exact: true });
    const count = await matches.count();
    if (!count || (command.occurrence === undefined && count !== 1) || (command.occurrence ?? 0) >= count)
      throw new ServiceError('AMBIGUOUS_CONTROL', 'Use the exact role and name shown in the form. Specify a zero-based occurrence for duplicates.');
    const element = await matches.nth(command.occurrence ?? 0).elementHandle({ timeout: 5000 });
    if (!element) throw new ServiceError('STALE_VIEW', 'The control changed.');
    const fingerprint = await this.describe(element);
    const p = this.previews.create<Pending>('view', this.session,
      { kind: 'form', frame, url: frame.url(), element, command, fingerprint });
    return { area: this.area, pageTitle: await this.page!.title(), ...command, confirmationToken: p.token, expiresAt: p.expiresAt };
  }

  async confirm(token: string, confirmed: boolean) {
    const { payload } = this.previews.consume<Pending>(token, 'view', this.session, confirmed);
    if (payload.kind === 'open') {
      this.previews.clear();
      this.session = randomUUID();
      this.area = payload.dest.area;
      const url = this.area === 'osiris_registration' ? studentOrigin + '/inschrijven'
        : this.area === 'planapp' ? planOrigin + '/plan'
        : canvasOrigin + '/courses/' + payload.dest.courseId + '/assignments/' + payload.dest.assignmentId;
      this.page = await this.browser.open(url);
      const root = this.area === 'planapp' ? 'pa-plan-page' : this.area === 'osiris_registration'
        ? 'ion-router-outlet .ion-page:not(.ion-page-hidden)' : '#content';
      await this.page.locator(root).first().waitFor({ state: 'attached', timeout: 20000 });
      return this.view();
    }
    const { element, frame, command } = payload;
    try {
      if (!this.frames().includes(frame) || frame.url() !== payload.url || await this.describe(element) !== payload.fingerprint)
        throw new ServiceError('STALE_VIEW', 'The form changed. Read it again and prepare a fresh action.');
      const opts = { timeout: 10000 };
      if (command.action === 'fill') await element.fill(command.value!, opts);
      else if (command.action === 'select') await element.selectOption({ label: command.value! }, opts);
      else await element.click(opts);
      return { controlActivated: true, next: 'Use campus_form_view to check the portal response or receipt.' };
    } finally { await element.dispose(); }
  }
}
