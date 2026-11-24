import { createHash } from 'node:crypto';
import type { CanvasHttp } from './canvas-http.js';
import { readableHtml, nextPage } from './canvas.js';
import { PreviewStore } from './previews.js';
import { canvasOrigin, ServiceError } from './shared.js';

export interface Target { courseId: string; quizId: string }
export interface Answer { id: string; answer: unknown }
type Change = Target & { action: 'start' | 'answer' | 'finish'; answers?: Answer[] };
interface Attempt { id: string; attempt: number; workflow_state: string; validation_token?: string; user_id: string }
interface Question { id: string; question_type: string; question_text: string; answers?: Record<string, unknown>[]; answer?: unknown }

export class Quizzes {
  private previews = new PreviewStore();
  private tokens = new Map<string, string>();
  constructor(private http: CanvasHttp, private identity: () => Promise<string>) {}
  private base(t: Target) { return '/api/v1/courses/' + t.courseId + '/quizzes/' + t.quizId; }

  private async api(path: string, method = 'GET', body?: unknown) {
    const r = await this.http.request({ url: canvasOrigin + path, method,
      accept: 'application/json+canvas-string-ids', type: body === undefined ? '' : 'application/json',
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status < 200 || r.status >= 300)
      throw new ServiceError('QUIZ_REQUEST_FAILED', `Canvas returned HTTP ${r.status} for this quiz operation. Check its access rules and attempt state.`);
    return { data: JSON.parse(r.body.replace(/^\s*while\s*\(1\)\s*;\s*/, '')), link: r.headers.link || '' };
  }

  private async current(t: Target, account: string): Promise<Attempt> {
    const { data } = await this.api(this.base(t) + '/submission');
    const a: Attempt = data.quiz_submissions?.[0];
    if (!a || String(a.user_id) !== account || !/^\d+$/.test(String(a.id)) || a.workflow_state !== 'untaken')
      throw new ServiceError('NO_ACTIVE_ATTEMPT', 'Canvas did not return an in-progress attempt for this account.');
    return a;
  }
  async questions(t: Target, page: string) {
    const account = await this.identity();
    const a = await this.current(t, account);
    const path = '/api/v1/quiz_submissions/' + a.id + '/questions?per_page=50&page=' + encodeURIComponent(page);
    const { data, link } = await this.api(path);
    if (!Array.isArray(data.quiz_submission_questions)) throw new ServiceError('UNEXPECTED_RESPONSE', 'Canvas did not return learner questions.');
    return { attempt: a.attempt, nextPage: nextPage(link, new URL(path, canvasOrigin)),
      questions: data.quiz_submission_questions.map((q: Question) => ({
        id: q.id, type: q.question_type, prompt: readableHtml(q.question_text), currentAnswer: q.answer,
        choices: q.answers?.map(choice => ({ id: choice.id, text: readableHtml(choice.html || choice.text),
          left: choice.left, right: choice.right, matchId: choice.match_id, blankId: choice.blank_id })),
      })) };
  }

  private async state(t: Change, account: string) {
    const { data: q } = await this.api(this.base(t));
    if (String(q.id) !== String(t.quizId)) throw new ServiceError('INVALID_QUIZ', 'Canvas did not identify this quiz.');
    const a = t.action === 'start' ? undefined : await this.current(t, account);
    const summary = { courseId: t.courseId, quizId: t.quizId, title: q.title, timeLimitMinutes: q.time_limit,
      allowedAttempts: q.allowed_attempts, due: q.due_at, attempt: a?.attempt, submissionId: a?.id };
    return { summary, a };
  }
  async prepare(change: Change) {
    if (change.action === 'answer' ? !change.answers?.length : change.answers !== undefined)
      throw new ServiceError('INVALID_ARGUMENT', 'Supply answers only when saving answers.');
    const account = await this.identity();
    const { summary } = await this.state(change, account);
    const snapshot = JSON.stringify(summary);
    const { token, expiresAt } = this.previews.create('quiz', account, { change, snapshot });
    return { ...summary, action: change.action, answers: change.answers, confirmationToken: token, expiresAt };
  }
  async confirm(token: string, confirmed: boolean) {
    const account = await this.identity();
    const { payload } = this.previews.consume<{ change: Change; snapshot: string }>(token, 'quiz', account, confirmed);
    const { change } = payload;
    const { summary, a } = await this.state(change, account);
    if (JSON.stringify(summary) !== payload.snapshot) throw new ServiceError('STATE_CHANGED', 'The quiz or attempt changed. Prepare a fresh preview.');
    const key = (attempt: Attempt) => createHash('sha256').update(JSON.stringify([account, change.courseId, change.quizId, attempt.id, attempt.attempt])).digest('hex');
    if (change.action === 'start') {
      const { data } = await this.api(this.base(change) + '/submissions', 'POST', {});
      const started: Attempt = data.quiz_submissions?.[0];
      if (!started || started.workflow_state !== 'untaken' || String(started.user_id) !== account)
        throw new ServiceError('OUTCOME_UNKNOWN', 'Inspect the quiz before retrying.');
      if (started.validation_token) this.tokens.set(key(started), started.validation_token);
      return { state: started.workflow_state, attempt: started.attempt, submissionId: started.id };
    }
    const validation = a!.validation_token || this.tokens.get(key(a!));
    if (!validation) throw new ServiceError('ATTEMPT_UNAVAILABLE', 'This attempt must be continued in the Canvas quiz interface.');
    const auth = { attempt: a!.attempt, validation_token: validation };
    if (change.action === 'answer') {
      const { data } = await this.api('/api/v1/quiz_submissions/' + a!.id + '/questions', 'POST', { ...auth, quiz_questions: change.answers });
      const returned = new Set((data.quiz_submission_questions || []).map((q: Question) => String(q.id)));
      if (change.answers!.some(q => !returned.has(q.id)))
        throw new ServiceError('OUTCOME_UNKNOWN', 'Canvas did not acknowledge every answer. Read the attempt before retrying.');
      return { saved: change.answers!.map(x => x.id), attempt: a!.attempt };
    }
    const { data } = await this.api(this.base(change) + '/submissions/' + a!.id + '/complete', 'POST', auth);
    const result: Attempt = data.quiz_submissions?.[0];
    if (!result || String(result.id) !== String(a!.id) || !['complete','pending_review'].includes(result.workflow_state))
      throw new ServiceError('OUTCOME_UNKNOWN', 'Canvas did not confirm completion. Check the attempt before retrying.');
    this.tokens.delete(key(a!));
    return { submissionId: result.id, attempt: result.attempt, state: result.workflow_state };
  }
}
