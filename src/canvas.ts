import type { CanvasHttp } from './canvas-http.js';
import { load } from 'cheerio';
import { canvasOrigin, authRequired, ServiceError } from './shared.js';

type Row = Record<string, unknown>;
type Mapping = (row: Row) => Row;

export function decodeCanvas(status: number, type: string, body: string): unknown {
  if ([301, 302, 303, 307, 308, 401].includes(status)) throw authRequired('Canvas');
  if (status === 403) throw new ServiceError('ACCESS_DENIED', 'Canvas denied access to this resource.');
  if (status === 429) throw new ServiceError('RATE_LIMITED', 'Canvas rate limit reached. Try again later.');
  if (status !== 200) throw new ServiceError('CANVAS_ERROR', `Canvas returned HTTP ${status}.`);
  if (!type.includes('json')) throw new ServiceError('UNEXPECTED_RESPONSE', 'Canvas did not return API data.');
  return JSON.parse(body.replace(/^\s*while\s*\(\s*1\s*\)\s*;\s*/, ''));
}

export function nextPage(link: string, current: URL) {
  for (const match of link.matchAll(/<([^>]+)>\s*;\s*rel="([^"]+)"/g)) {
    if (match[2] !== 'next') continue;
    const next = new URL(match[1]!, current);
    if (next.origin !== current.origin || next.pathname !== current.pathname || !next.searchParams.has('page'))
      throw new ServiceError('UNEXPECTED_RESPONSE', 'Canvas returned an unrecognized pagination link.');
    return next.searchParams.get('page');
  }
  return null;
}

export class Canvas {
  constructor(private http: CanvasHttp) {}

  private async get(url: URL) {
    const r = await this.http.request({ url: url.href, method: 'GET', accept: 'application/json+canvas-string-ids', type: '' });
    return { data: decodeCanvas(r.status, r.headers['content-type'] || '', r.body), link: r.headers.link || '' };
  }
  async identity() {
    const { data } = await this.get(new URL('/api/v1/users/self/profile', canvasOrigin));
    if (!data || typeof data !== 'object' || !('id' in data) || !/^\d+$/.test(String(data.id)))
      throw new ServiceError('UNEXPECTED_RESPONSE', 'Canvas did not return the signed-in profile.');
    return String(data.id);
  }

  async list(path: string, params: Record<string, string>, page: string, project: Mapping) {
    const url = new URL('/api/v1/' + path, canvasOrigin);
    for (const [key, value] of Object.entries({ ...params, page, per_page: '50' })) url.searchParams.set(key, value);
    const { data, link } = await this.get(url);
    if (!Array.isArray(data) || data.some(row => !row || typeof row !== 'object' || !('id' in row)))
      throw new ServiceError('UNEXPECTED_RESPONSE', 'Canvas returned an unexpected list.');
    return { items: data.map(project), nextPage: nextPage(link, url) };
  }
}

export const course = (r: Row) => ({
  id: r.id, name: r.name, code: r.course_code, starts: r.start_at, ends: r.end_at,
  grades: Array.isArray(r.enrollments) ? r.enrollments.map(e => ({
    role: e.type, currentScore: e.computed_current_score, currentGrade: e.computed_current_grade,
  })) : [],
});
export const assignment = (r: Row) => ({
  id: r.id, name: r.name, due: r.due_at, unlocks: r.unlock_at, closes: r.lock_at,
  points: r.points_possible, submissionTypes: r.submission_types,
});
export const moduleInfo = (r: Row) => ({ id: r.id, name: r.name, position: r.position, itemCount: r.items_count });
export const moduleItem = (r: Row) => ({ id: r.id, title: r.title, type: r.type, position: r.position, contentId: r.content_id });
export const announcement = (r: Row) => ({ id: r.id, title: r.title, posted: r.posted_at, message: readableHtml(r.message) });

export function readableHtml(html: unknown) {
  const doc = load(String(html || ''));
  doc('script,style,input,button').remove();
  doc('p,br,div,li').append('\n');
  return doc.text().trim();
}
