import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape } from 'zod';
import { PortalBrowser } from './browser.js';
import { Canvas, course, assignment, moduleInfo, moduleItem, announcement } from './canvas.js';
import { CanvasHttp } from './canvas-http.js';
import { Catalog } from './catalog.js';
import { Quizzes } from './quiz.js';
import { portalView } from './portals.js';
import { configuredFeed, readTimetable } from './feed.js';
import { safeError } from './shared.js';
import { attachment } from './uploads.js';
import { Workflows, roles } from './workflows.js';

const id = z.string().regex(/^\d{1,25}$/);
const page = z.string().min(1).max(2000).default('1');
const args = z.record(z.string(), z.unknown());
const confirmation = { confirmationToken: z.string().min(16).max(200), confirmed: z.literal(true) };
const coursePage = { courseId: id, page };
const target = { courseId: id, quizId: id };

export function createServer(browser = new PortalBrowser(), http = new CanvasHttp(browser)) {
  const server = new McpServer({ name: 'tueindhoven-mcp', version: '0.1.0' });
  const canvas = new Canvas(http);
  const who = () => canvas.identity();
  const catalog = new Catalog(http, who);
  const quizzes = new Quizzes(http, who);
  const workflows = new Workflows(browser);

  function register<S extends ZodRawShape>(name: string, description: string, inputSchema: S,
    handler: (p: z.output<z.ZodObject<S>>) => Promise<unknown>, write = false) {
    const schema: z.ZodObject<ZodRawShape> = z.object(inputSchema);
    server.registerTool(name, { description, inputSchema: schema, annotations: { readOnlyHint: !write,
      destructiveHint: write, idempotentHint: !write, openWorldHint: true } }, async (p) => {
      try {
        const result = await handler(p as z.output<z.ZodObject<S>>);
        if (result && typeof result === 'object' && 'content' in result && Array.isArray(result.content))
          return result as CallToolResult;
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(safeError(error)) }] };
      }
    });
  }

  register('canvas_account', 'Check the signed-in TU/e Canvas account.', {}, async () => ({ authenticated: Boolean(await who()) }));
  register('canvas_courses', 'My active Canvas courses with enrollment roles and available grades.', { page },
    p => canvas.list('courses', { 'include[]': 'total_scores' }, p.page, course));
  register('canvas_assignments', 'List assignments, submission formats and deadlines.', coursePage,
    p => canvas.list(`courses/${p.courseId}/assignments`, {}, p.page, assignment));
  register('canvas_modules', 'List course modules.', coursePage,
    p => canvas.list(`courses/${p.courseId}/modules`, {}, p.page, moduleInfo));
  register('canvas_module_items', 'Read the items in a course module.', { ...coursePage, moduleId: id },
    p => canvas.list(`courses/${p.courseId}/modules/${p.moduleId}/items`, {}, p.page, moduleItem));
  register('canvas_announcements', 'Read course announcements.', coursePage,
    p => canvas.list('announcements', { 'context_codes[]': 'course_' + p.courseId, active_only: 'true' }, p.page, announcement));
  register('canvas_search_tools', 'Discover Canvas operations for students, teachers, TAs and administrators. Search for assignments, submissions, quizzes, grading, enrollments, groups, messages or other coursework.', { query: z.string().max(200).default(''), offset: z.number().int().min(0).default(0) }, async p => {
    const terms = p.query.toLowerCase().split(/[\s_]+/).filter(Boolean);
    const matches = (await catalog.list()).filter(t => terms.every(term => (t.name + ' ' + t.description).toLowerCase().includes(term)));
    return { total: matches.length, items: matches.slice(p.offset, p.offset + 30).map(t => ({
      name: t.name, readOnly: t.annotations?.readOnlyHint === true, description: t.description?.slice(0, 220),
    })) };
  });
  register('canvas_describe_tool', 'Get the full input schema and usage of a Canvas catalog operation.', { name: z.string() }, p => catalog.find(p.name));
  register('canvas_read_tool', 'Run a read-only catalog operation with your actual Canvas permissions.', { name: z.string(), arguments: args }, p => catalog.read(p.name, p.arguments));
  register('canvas_prepare_action', 'Preview a Canvas catalog change such as submit_assignment, upload_submission_file, create_assignment, grade_submission or send a message. Show the exact preview to the user.', { name: z.string(), arguments: args }, p => catalog.prepare(p.name, p.arguments));
  register('canvas_prepare_file_upload', 'Preview a file from Downloads or TUE_UPLOAD_DIR for a particular assignment. Confirming uploads the captured bytes and returns a Canvas file ID. Use submit_assignment with online_upload and that file ID to turn it in.', {
    courseId: id, assignmentId: id, filename: z.string().min(1), contentType: z.string().default('application/octet-stream'),
  }, async p => catalog.prepare('upload_submission_file', { course_id: p.courseId, assignment_id: p.assignmentId,
    content_type: p.contentType, ...await attachment(p.filename) }));
  register('canvas_confirm_action', 'Execute one previously previewed Canvas change after the user approves it. Check the result in Canvas before retrying an uncertain write.', confirmation, p => catalog.confirm(p.confirmationToken, p.confirmed), true);
  register('canvas_quiz_questions', 'Read learner-facing questions, answer options and saved answers in your active Classic Quiz. Use these to work through the questions with the student.', { ...target, page }, p => quizzes.questions(p, p.page));
  register('canvas_prepare_quiz', 'Preview starting a Classic Quiz, saving the specified question answers, or finishing the current attempt. Starting may use an attempt and start a timer. Answer values follow the Canvas question type.', {
    ...target, action: z.enum(['start', 'answer', 'finish']),
    answers: z.array(z.object({ id, answer: z.json() })).min(1).max(200).optional(),
  }, p => quizzes.prepare(p));
  register('canvas_confirm_quiz', 'Apply the exact quiz action after user approval. Completion submits the attempt.', confirmation, p => quizzes.confirm(p.confirmationToken, p.confirmed), true);
  register('osiris_grades', 'Read official results from the signed-in OSIRIS Student portal.', {}, () => portalView(browser, 'grades'));
  register('osiris_progress', 'Read current programme progress from OSIRIS Student.', {}, () => portalView(browser, 'progress'));
  register('planapp_plan', 'Read the study years and course planning in the current OSIRIS PlanApp plan.', {}, () => portalView(browser, 'plan'));
  register('campus_prepare_open', 'Preview opening the active PlanApp planning UI, OSIRIS course registration UI, or a Canvas New Quizzes assignment. Opening an assessment can start a timer.', {
    area: z.enum(['planapp','osiris_registration','new_quiz']), courseId: id.optional(), assignmentId: id.optional(),
  }, async p => workflows.prepareOpen(p));
  register('campus_form_view', 'Read accessible text, questions and named form controls in the current university workflow.', {}, () => workflows.view());
  register('campus_prepare_control', 'Preview clicking a named control, filling an answer or selecting a labeled option in the current form. Use exactly the frame, role and accessible name shown by campus_form_view. Submission, registration and plan changes require student approval.', {
    frame: z.number().int().min(0), role: z.enum(roles), name: z.string().max(1200), occurrence: z.number().int().min(0).optional(),
    action: z.enum(['click','fill','select']), value: z.string().max(50000).optional(),
  }, p => workflows.prepare(p));
  register('campus_confirm', 'Apply the specific approved form action once. Inspect the resulting page for confirmation.', confirmation, p => workflows.confirm(p.confirmationToken, p.confirmed), true);
  register('get_timetable', 'Read personal TE Timetable events overlapping the requested interval. Defaults to the next 30 days. Results include Amsterdam local time.', {
    from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
  }, async p => {
    const from = p.from || new Date().toISOString();
    return readTimetable(await configuredFeed(), from, p.to || new Date(Date.parse(from) + 30 * 86400000).toISOString());
  });
  return { server, async close() { await catalog.close(); await browser.close(); } };
}
