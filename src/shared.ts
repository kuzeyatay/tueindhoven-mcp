export const TIMEZONE = 'Europe/Amsterdam';
export const canvasOrigin = 'https://canvas.tue.nl';
export const studentOrigin = 'https://tue.osiris-student.nl';
export const planOrigin = 'https://tue.osiris-planapp.nl';
export const timetableEntry = 'https://cloud.timeedit.net/nl_tue/web/stud01/';

export class ServiceError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export const authRequired = (service: string) =>
  new ServiceError('AUTH_REQUIRED', `Sign in to ${service} in the MCP browser using npm run login.`);

export function safeError(error: unknown) {
  return error instanceof ServiceError
    ? { code: error.code, message: error.message }
    : { code: 'UNAVAILABLE', message: 'The service could not be read. Check connectivity and retry.' };
}

export const str = (v: unknown) => typeof v === 'string' || typeof v === 'number' ? String(v) : '';
export const plainText = (v: string) => v.replace(/\r/g, '').trim();
const localFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE, dateStyle: 'medium', timeStyle: 'short',
});
export const toLocal = (iso: string) => localFormatter.format(new Date(iso));
