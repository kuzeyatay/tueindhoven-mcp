import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { open, realpath } from 'node:fs/promises';
import { ServiceError } from './shared.js';

/** An explicit file in Downloads (or the operator's chosen upload directory). */
export async function attachment(filename: string) {
  const directory = await realpath(process.env.TUE_UPLOAD_DIR || join(homedir(), 'Downloads'));
  const file = await realpath(isAbsolute(filename) ? filename : join(directory, filename));
  const child = relative(directory, file);
  if (!child || child === '..' || child.startsWith('..' + sep) || isAbsolute(child))
    throw new ServiceError('INVALID_FILE', 'Choose a file inside Downloads or TUE_UPLOAD_DIR.');
  const fd = await open(file, 'r');
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024)
      throw new ServiceError('INVALID_FILE', 'Choose a regular file of 20 MiB or less.');
    const bytes = await fd.readFile();
    return { name: basename(file), content_base64: bytes.toString('base64') };
  } finally { await fd.close(); }
}
