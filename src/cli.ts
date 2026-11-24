#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PortalBrowser } from './browser.js';
import { login } from './login.js';
import { createServer } from './server.js';
import { safeError } from './shared.js';
import { setup } from './setup.js';
import { wizard } from './wizard.js';

const command = process.argv[2] || 'serve';
async function main() {
  if (command === 'install' || command === 'connect') {
    await wizard(command === 'install');
  } else if (command === 'setup') {
    await setup(process.argv.slice(3).find(s => !s.startsWith('--')), process.argv.includes('--dry-run'));
  } else if (command === 'login') {
    const browser = new PortalBrowser(true);
    try { await login(browser, process.argv[3]); } finally { await browser.close(); }
  } else if (command === 'serve') {
    const { server, close } = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    server.server.onclose = () => { void close(); };
  } else {
    console.error('Usage: tueindhoven-mcp serve | setup [codex|claude|cursor|vscode] [--dry-run] | login [canvas|osiris|planapp|timetable]');
    process.exitCode = 2;
  }
}
main().catch(error => { console.error(safeError(error).message); process.exitCode = 1; });
