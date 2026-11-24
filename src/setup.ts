import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeJsonFile, mergeTomlSection } from './setup/files.js';
import { ServiceError } from './shared.js';

export async function setup(choice?: string, dryRun = false) {
  const home = homedir();
  const apps = process.platform === 'win32' ? process.env.APPDATA || join(home,'AppData','Roaming')
    : process.platform === 'darwin' ? join(home,'Library','Application Support') : process.env.XDG_CONFIG_HOME || join(home,'.config');
  const clients = [
    { id: 'codex', name: 'Codex', path: join(process.env.CODEX_HOME || join(home,'.codex'), 'config.toml') },
    { id: 'claude', name: 'Claude Desktop', path: join(apps, 'Claude', 'claude_desktop_config.json') },
    { id: 'cursor', name: 'Cursor', path: join(home,'.cursor','mcp.json') },
    { id: 'vscode', name: 'VS Code', path: join(apps,'Code','User','mcp.json') },
  ];
  if (!choice) {
    const io = createInterface({ input: process.stdin, output: process.stderr });
    try {
      clients.forEach((c, i) => console.error(`${i + 1}. ${c.name}`));
      choice = (await io.question('Which app will you use? Enter its number and press Enter. ')).trim();
    } finally { io.close(); }
  }
  const client = clients.find((c, i) => c.id === choice || String(i + 1) === choice);
  if (!client) throw new ServiceError('INVALID_CLIENT', 'Choose codex, claude, cursor or vscode.');
  const entry = { command: process.execPath, args: [fileURLToPath(new URL('./cli.js', import.meta.url)), 'serve'] };
  const result = client.id === 'codex'
    ? await mergeTomlSection(client.path, '[mcp_servers.tueindhoven]',
      'command = ' + JSON.stringify(entry.command) + '\nargs = ' + JSON.stringify(entry.args), dryRun)
    : await mergeJsonFile(client.path, [client.id === 'vscode' ? 'servers' : 'mcpServers','tueindhoven'],
      client.id === 'vscode' ? { type: 'stdio', ...entry } : entry, dryRun);
  if (result.manual) throw new ServiceError('SETUP_FAILED', result.manual);
  console.error(dryRun ? 'Configuration preview' : `Configured ${client.name}. Restart it after signing in.`);
  console.error(client.path);
  if (dryRun) console.error(result.preview);
}
