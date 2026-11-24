import { createInterface } from 'node:readline/promises';
import { PortalBrowser } from './browser.js';
import { login } from './login.js';
import { setup } from './setup.js';
import { ServiceError } from './shared.js';

export async function wizard(configure: boolean) {
  if (configure) await setup();
  const options = ['canvas','osiris','planapp','timetable'];
  console.error('Choose services: 1 Canvas, 2 OSIRIS Student, 3 PlanApp, 4 TE Timetable.');
  const io = createInterface({ input: process.stdin, output: process.stderr });
  let selection: string;
  try { selection = (await io.question('Press Enter for all four, or enter numbers separated by spaces. ')).trim(); }
  finally { io.close(); }
  const numbers = selection ? [...new Set(selection.split(/[ ,]+/))] : ['1','2','3','4'];
  if (numbers.some(n => !/^[1-4]$/.test(n))) throw new ServiceError('INVALID_CHOICE', 'Choose numbers from 1 to 4.');
  const browser = new PortalBrowser(true);
  try { for (const n of numbers) await login(browser, options[Number(n) - 1]); }
  finally { await browser.close(); }
  console.error('Sign-in finished. Fully quit and reopen your AI app, then ask about your courses.');
}
