import type { Page } from 'playwright-core';
import { PortalBrowser } from './browser.js';
import { authRequired, canvasOrigin, ServiceError } from './shared.js';

export interface ApiRequest { url: string; method: string; accept: string; type: string; body?: string }
export interface ApiReply { status: number; body: string; headers: Record<string, string> }

export function apiURL(value: string) {
  const url = new URL(value);
  if (url.origin !== canvasOrigin || url.username || url.password ||
      !/^\/api\/(?:v1\/|quiz\/v1\/|graphql$)/.test(url.pathname))
    throw new ServiceError('INVALID_ENDPOINT', 'This operation needs an unsupported Canvas endpoint.');
  return url;
}

export class CanvasHttp {
  private session?: Promise<Page>;
  constructor(private browser: PortalBrowser) {}

  private async canvasPage() {
    const page = await this.browser.open(canvasOrigin);
    try { await page.locator('#global_nav_profile_link').waitFor({ timeout: 12000 }); }
    catch { throw authRequired('Canvas'); }
    if (new URL(page.url()).origin !== canvasOrigin) throw authRequired('Canvas');
    return page;
  }

  async request(args: ApiRequest): Promise<ApiReply> {
    apiURL(args.url);
    const token = process.env.TUE_CANVAS_TOKEN;
    if (token) {
      const headers: Record<string, string> = { accept: args.accept, authorization: 'Bearer ' + token };
      if (args.type) headers['content-type'] = args.type;
      const r = await fetch(args.url, { method: args.method, headers, body: args.body, redirect: 'manual',
        signal: AbortSignal.timeout(30000) });
      return { status: r.status, body: await r.text(), headers: {
        'content-type': r.headers.get('content-type') || '', link: r.headers.get('link') || '',
      } };
    }
    this.session ??= this.canvasPage().catch(err => { this.session = undefined; throw err; });
    const page = await this.session;
    if (page.isClosed() || new URL(page.url()).origin !== canvasOrigin) {
      this.session = undefined;
      throw authRequired('Canvas');
    }
    // Use the ordinary same-origin Canvas session and Canvas's double-submit CSRF convention.
    // Both the session cookie and the CSRF value stay in the Canvas page.
    const reply = await page.evaluate(async (input) => {
      if (location.origin !== new URL(input.url).origin) throw Error('Origin changed');
      const headers: Record<string, string> = { Accept: input.accept };
      if (input.type) headers['Content-Type'] = input.type;
      if (!['GET', 'HEAD'].includes(input.method)) {
        const match = document.cookie.match(/(?:^|;\s*)_csrf_token=([^;]+)/);
        if (!match) throw Error('Canvas session is missing its form token');
        headers['X-CSRF-Token'] = decodeURIComponent(match[1]!);
      }
      const res = await fetch(input.url, { method: input.method, credentials: 'same-origin', headers,
        body: input.body, redirect: 'error', signal: AbortSignal.timeout(30000) });
      return { status: res.status, body: await res.text(), headers: {
        'content-type': res.headers.get('content-type') || '', link: res.headers.get('link') || '',
      } };
    }, args);
    if (reply.status === 401) this.session = undefined;
    return reply;
  }
}
