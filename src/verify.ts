import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const env = getDefaultEnvironment();
for (const key of ['TUE_CANVAS_TOKEN', 'TUE_TIMETABLE_ICS', 'TUE_BROWSER_PATH', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)'])
  if (process.env[key]) env[key] = process.env[key]!;
const transport = new StdioClientTransport({ command: process.execPath, env,
  args: [fileURLToPath(new URL('./cli.js', import.meta.url)), 'serve'] });
const client = new Client({ name: 'tueindhoven-live-check', version: '0.1.0' });
async function run(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 95000 });
  const content = result.content as { text?: string }[];
  const value = JSON.parse(content[0]!.text!);
  if (result.isError) throw Error(typeof value.code === 'string' ? value.code : 'TOOL_ERROR');
  return value;
}
let failures = 0;
async function check(label: string, task: () => Promise<string>) {
  try { console.log(`PASS ${label} — ${await task()}`); }
  catch (error) {
    const msg = error instanceof Error ? error.message : '';
    console.log(`FAIL ${label} — ${/^[A-Z_]+$/.test(msg) ? msg : 'CHECK_FAILED'}`);
    failures++;
  }
}
try {
  await client.connect(transport);
  console.log(`MCP connected, ${(await client.listTools()).tools.length} tools`);
  await check('Canvas', async () => {
    if (!(await run('canvas_account')).authenticated) throw Error('AUTH_REQUIRED');
    const { items } = await run('canvas_courses');
    if (!Array.isArray(items)) throw Error('UNEXPECTED_RESPONSE');
    if (items[0]) {
      const result = await run('canvas_assignments', { courseId: String(items[0].id) });
      if (!Array.isArray(result.items)) throw Error('UNEXPECTED_RESPONSE');
    }
    return `${items.length} courses on first page`;
  });
  await check('Canvas catalog', async () => {
    const data = await run('canvas_search_tools');
    if (!data.total || !(await run('canvas_describe_tool', { name: 'submit_assignment' })).inputSchema) throw Error('CATALOG_UNAVAILABLE');
    await run('canvas_read_tool', { name: 'list_courses', arguments: {} });
    return `${data.total} operations, authenticated course read`;
  });
  for (const [label, name] of [['OSIRIS results','osiris_grades'],['OSIRIS progress','osiris_progress'],['PlanApp','planapp_plan'],['TE Timetable','get_timetable']] as const)
    await check(label, async () => {
      const { items } = await run(name);
      if (!Array.isArray(items)) throw Error('UNEXPECTED_RESPONSE');
      return `${items.length} records`;
    });
} finally { await client.close(); }
process.exitCode = failures ? 1 : 0;
