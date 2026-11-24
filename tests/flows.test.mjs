import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';
import { apiURL } from '../dist/canvas-http.js';
import { feedUrl, schedulePage } from '../dist/feed.js';
import { expandCalendar } from '../dist/ical.js';
import { nextPage } from '../dist/canvas.js';
import { chromium } from 'playwright-core';
import { executable } from '../dist/browser.js';
import { Workflows } from '../dist/workflows.js';

// Only the university HTTP boundary is replaced. MCP validation, SDK calls,
// catalog discovery/dispatch and confirmation all run as in the released server.
async function fixture(t) {
  const requests = [];
  let account = '17';
  let state = 'settings_only';
  const base = '/api/v1/courses/21/quizzes/43';
  const attempt = () => ({ id: '90', quiz_id: '43', user_id: account, attempt: 1,
    workflow_state: state, validation_token: 'fixture-attempt-key' });
  let saved = null;
  const http = { request: async r => {
    const path = apiURL(r.url).pathname;
    const body = r.body && JSON.parse(r.body);
    requests.push({ path, method: r.method, body });
    let data;
    let status = 200;
    if (path.endsWith('/users/self/profile')) data = { id: account };
    else if (path === base) data = { id: '43', title: 'Practice arithmetic', time_limit: 5, allowed_attempts: 1 };
    else if (path === base + '/submissions' && r.method === 'POST') {
      state = 'untaken'; data = { quiz_submissions: [attempt()] };
    } else if (path === base + '/submission') data = { quiz_submissions: [attempt()] };
    else if (path === '/api/v1/quiz_submissions/90/questions') {
      if (r.method === 'POST') {
        assert.equal(body.validation_token, 'fixture-attempt-key');
        assert.equal(body.attempt, 1);
        saved = body.quiz_questions[0].answer;
      }
      data = { quiz_submission_questions: [{ id: '51', question_type: 'multiple_choice_question',
        question_text: '<p>What is 2 + 2?</p>', answers: [{ id: 7, text: '4' }], answer: saved }] };
    } else if (path === base + '/submissions/90/complete') {
      assert.equal(body.validation_token, 'fixture-attempt-key'); state = 'complete';
      data = { quiz_submissions: [attempt()] };
    } else if (path === '/api/v1/courses/21/assignments/7/submissions/self/files') {
      data = { upload_url: 'https://storage.fixture.invalid/one-upload', upload_params: { policy: 'fixture-policy' } };
    } else if (path === '/api/v1/courses/21/assignments/7/submissions') {
      data = { id: 99, assignment_id: 7, workflow_state: 'submitted' };
    } else if (path === '/api/v1/courses/21/assignments/7/submissions/17' && r.method === 'PUT') {
      data = { id: 99, grade: body.submission.posted_grade };
    } else if (path === '/api/v1/courses/21/assignments' && r.method === 'POST') {
      data = { id: 300, name: body.assignment.name, published: false };
    } else if (path.startsWith('/api/v1/courses/99/')) {
      status = 403; data = { message: 'Permission denied' };
    } else throw Error('Unexpected fixture operation');
    return { status, body: JSON.stringify(data), headers: { 'content-type': 'application/json' } };
  } };
  const service = createServer({ close: async () => {} }, http);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture', version: '1' });
  await service.server.connect(s);
  await client.connect(c);
  t.after(async () => { await client.close(); await service.close(); });
  async function call(name, args = {}) {
    const response = await client.callTool({ name, arguments: args });
    const raw = response.content[0].text;
    if (response.isError) throw Error(raw);
    return JSON.parse(raw);
  }
  return { call, requests, setAccount: id => { account = id; } };
}

test('student previews and submits text, URLs and existing Canvas file IDs through MCP', async t => {
  const { call, requests } = await fixture(t);
  for (const [type, field, value] of [['online_text_entry','body','My answer'], ['online_url','url','https://example.org/work'], ['online_upload','file_ids',['81']]]) {
    const args = { course_id: 21, assignment_id: 7, submission_type: type, [field]: value };
    const before = requests.filter(r => r.method === 'POST').length;
    const p = await call('canvas_prepare_action', { name: 'submit_assignment', arguments: args });
    assert.deepEqual(p.arguments, args);
    assert.equal(requests.filter(r => r.method === 'POST').length, before);
    await call('canvas_confirm_action', { confirmationToken: p.confirmationToken, confirmed: true });
    assert.deepEqual(requests.filter(r => r.method === 'POST').at(-1).body.submission[field], value);
    await assert.rejects(call('canvas_confirm_action', { confirmationToken: p.confirmationToken, confirmed: true }), /PREVIEW_EXPIRED/);
  }
});

test('approved upload sends the exact bytes to Canvas-authorized storage and yields a submission file ID', async t => {
  const { call, requests } = await fixture(t);
  const bytes = Buffer.from('Practice answer');
  const p = await call('canvas_prepare_action', { name: 'upload_submission_file', arguments: {
    course_id: '21', assignment_id: '7', name: 'answer.txt', content_type: 'text/plain', content_base64: bytes.toString('base64'),
  } });
  assert.equal(p.arguments.content_base64.bytes, bytes.length);
  assert.match(p.arguments.content_base64.sha256, /^[a-f0-9]{64}$/);
  assert.ok(requests.every(r => r.method === 'GET'));
  const file = await call('canvas_confirm_action', { confirmationToken: p.confirmationToken, confirmed: true });
  assert.equal(String(file.id), '81');
  assert.equal(requests.at(-1).body.name, 'answer.txt');
  assert.equal(requests.at(-1).body.size, String(bytes.length));
});

test('catalog exposes staff tools, preserves permission denials and binds approvals to an account', async t => {
  const { call, requests, setAccount } = await fixture(t);
  assert.ok((await call('canvas_search_tools')).total >= 180);
  for (const name of ['grade_submission','create_assignment','upload_submission_file','submit_assignment'])
    assert.ok((await call('canvas_describe_tool', { name })).inputSchema);
  const args = { course_id: 21, name: 'Draft assignment', published: false };
  await assert.rejects(call('canvas_read_tool', { name: 'create_assignment', arguments: args }), /PREVIEW_REQUIRED/);
  const p = await call('canvas_prepare_action', { name: 'create_assignment', arguments: args });
  setAccount('18');
  await assert.rejects(call('canvas_confirm_action', { confirmed: true, confirmationToken: p.confirmationToken }), /ACCOUNT_CHANGED/);
  assert.equal(requests.filter(r => r.method === 'POST').length, 0);
  const draft = await call('canvas_prepare_action', { name: 'create_assignment', arguments: args });
  await call('canvas_confirm_action', { confirmed: true, confirmationToken: draft.confirmationToken });
  assert.equal(requests.at(-1).body.assignment.published, false);
  const grading = await call('canvas_prepare_action', { name: 'grade_submission', arguments: {
    course_id: '21', assignment_id: '7', user_id: '17', grade: '8',
  } });
  await call('canvas_confirm_action', { confirmed: true, confirmationToken: grading.confirmationToken });
  assert.equal(requests.at(-1).body.submission.posted_grade, '8');
  const denied = await call('canvas_prepare_action', { name: 'create_assignment', arguments: { ...args, course_id: 99 } });
  await assert.rejects(call('canvas_confirm_action', { confirmed: true, confirmationToken: denied.confirmationToken }), /403|Permission|denied/i);
});

test('Classic Quiz start, learner question, answer save and final submission through MCP', async t => {
  const { call, requests } = await fixture(t);
  const target = { courseId: '21', quizId: '43' };
  const act = async (action, args = {}) => {
    const before = requests.filter(r => r.method === 'POST').length;
    const p = await call('canvas_prepare_quiz', { ...target, action, ...args });
    assert.equal(requests.filter(r => r.method === 'POST').length, before);
    const result = await call('canvas_confirm_quiz', { confirmed: true, confirmationToken: p.confirmationToken });
    assert.ok(!JSON.stringify(result).includes('fixture-attempt-key'));
    return result;
  };
  assert.equal((await act('start')).state, 'untaken');
  const { questions } = await call('canvas_quiz_questions', target);
  assert.equal(questions[0].prompt, 'What is 2 + 2?');
  await act('answer', { answers: [{ id: '51', answer: 7 }] });
  assert.equal((await call('canvas_quiz_questions', target)).questions[0].currentAnswer, 7);
  assert.equal((await act('finish')).state, 'complete');
  await assert.rejects(call('canvas_quiz_questions', target), /NO_ACTIVE_ATTEMPT/);
});

test('TimeEdit recurrence across Amsterdam DST and official TU/e URL boundaries', async () => {
  const ics = await readFile(new URL('./calendar.ics', import.meta.url), 'utf8');
  const data = expandCalendar(ics, '2026-03-01T00:00:00Z', '2026-04-30T00:00:00Z');
  assert.deepEqual(data.items.filter(i => i.uid === 'weekly-lecture@fixture').map(i => i.start),
    ['2026-03-16T12:45:00.000Z', '2026-03-23T12:45:00.000Z', '2026-04-06T13:45:00.000Z', '2026-04-13T11:45:00.000Z']);
  assert.equal(feedUrl('webcal://cloud.timeedit.net/nl_tue/web/stud01/example.ics').protocol, 'https:');
  assert.throws(() => feedUrl('https://cloud.timeedit.net/nl_tue/web/pub01/example.ics'));
  assert.throws(() => schedulePage('https://example.org/timetable.html'));
  assert.throws(() => apiURL('https://example.org/api/v1/courses'));
  assert.throws(() => apiURL('https://canvas.tue.nl/login'));
  assert.throws(() => nextPage('<https://example.org/api/v1/courses?page=2>; rel="next"', new URL('https://canvas.tue.nl/api/v1/courses')));
});

test('rendered planning, registration and embedded New Quiz controls run only after confirmation', async t => {
  const browser = await chromium.launch({ executablePath: executable(), headless: true });
  t.after(() => browser.close());
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await ctx.route('**/*', async route => {
    const origin = new URL(route.request().url()).origin;
    const docs = {
      'https://tue.osiris-planapp.nl': '<pa-plan-page><label>Course<input></label><button onclick="this.textContent=\'Saved plan\'">Save plan</button></pa-plan-page>',
      'https://tue.osiris-student.nl': '<ion-router-outlet><section class="ion-page"><button onclick="this.textContent=\'Registered\'">Register</button></section></ion-router-outlet>',
      'https://canvas.tue.nl': '<main id="content"><iframe title="Assessment" src="https://fixture.quiz-lti-dub-prod.instructure.com/assessment"></iframe></main>',
      'https://fixture.quiz-lti-dub-prod.instructure.com': '<fieldset><legend>What is 2 + 2?</legend><label><input type="radio" name="q">4</label></fieldset><button onclick="this.textContent=\'Attempt received\'">Submit quiz</button>',
    };
    if (!docs[origin]) return route.abort();
    await route.fulfill({ contentType: 'text/html', body: docs[origin] });
  });
  const flow = new Workflows({ open: async url => { await page.goto(url); return page; } });
  async function open(area) {
    const p = flow.prepareOpen({ area, courseId: '21', assignmentId: '7' });
    return flow.confirm(p.confirmationToken, true);
  }
  async function act(frame, role, name, action = 'click', value) {
    const p = await flow.prepare({ frame, role, name, action, value });
    return flow.confirm(p.confirmationToken, true);
  }
  await open('planapp');
  await act(0,'textbox','Course','fill','Fixture elective');
  const stale = await flow.prepare({ frame: 0, role: 'button', name: 'Save plan', action: 'click' });
  await page.getByRole('button').evaluate(el => { el.textContent='Discard plan'; });
  await assert.rejects(flow.confirm(stale.confirmationToken, true), /form changed/);
  await open('osiris_registration');
  await act(0,'button','Register');
  assert.match((await flow.view()).frames[0].content, /Registered/);
  await open('new_quiz');
  const quiz = (await flow.view()).frames.find(f => f.content.includes('What is 2 + 2?'));
  assert.ok(quiz);
  await act(quiz.frame,'radio','4');
  await act(quiz.frame,'button','Submit quiz');
  assert.match((await flow.view()).frames[quiz.frame].content, /Attempt received/);
});
