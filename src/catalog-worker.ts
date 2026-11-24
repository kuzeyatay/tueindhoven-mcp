// The embedded library uses fetch. Adapt only this worker's fetch to the
// signed-in Canvas transport. No socket or local HTTP proxy is opened.
import { parentPort } from 'node:worker_threads';
import { createCanvasMCPServer } from 'canvas-lms-mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ApiReply, ApiRequest } from './canvas-http.js';
import { canvasOrigin } from './shared.js';

const port = parentPort!;
const nativeFetch = globalThis.fetch;
const pending = new Map<number, (reply: ApiReply) => void>();
const uploads = new Map<string, number>();
let sequence = 0;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  // Use only the one-time destination that Canvas returned in an upload handshake.
  if (request.method === 'POST' && init?.body instanceof FormData && (uploads.get(url.href) ?? 0) > Date.now()) {
    uploads.delete(url.href);
    return nativeFetch(url, { body: init.body, method: 'POST', redirect: 'manual',
      signal: AbortSignal.timeout(60000) });
  }
  if (url.origin !== canvasOrigin) throw Error('Unsupported external Canvas resource.');
  const id = ++sequence;
  const args: ApiRequest = { url: url.href, method: request.method,
    type: request.headers.get('content-type') || '',
    accept: request.headers.get('accept') || 'application/json',
    body: request.body ? await request.text() : undefined };
  const promise = new Promise<ApiReply>(resolve => pending.set(id, resolve));
  port.postMessage({ type: 'http', id, args });
  const reply = await promise;
  const body = reply.body.replace(/^\s*while\s*\(\s*1\s*\)\s*;\s*/, '');
  if (request.method === 'POST' && /\/files$/.test(url.pathname) && reply.status < 300) {
    const location = JSON.parse(body)?.upload_url;
    if (typeof location === 'string') {
      const target = new URL(location, canvasOrigin);
      for (const [key, ttl] of uploads) if (ttl <= Date.now()) uploads.delete(key);
      if (target.protocol === 'https:' && !target.username && !target.password)
        uploads.set(target.href, Date.now() + 60000);
    }
  }
  return new Response([204, 205, 304].includes(reply.status) ? null : body, { status: reply.status, headers: reply.headers });
};

const { server } = createCanvasMCPServer({ token: 'local-transport', baseUrl: canvasOrigin,
  sharedAcrossCallers: false, enableAssignmentSubmission: true });
const client = new Client({ name: 'tueindhoven-catalog', version: '0.1.0' });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await server.connect(serverSide);
await client.connect(clientSide);
port.on('message', async msg => {
  if (msg.type === 'httpReply') {
    pending.get(msg.id)?.(msg.reply);
    pending.delete(msg.id);
    return;
  }
  try {
    const result = msg.type === 'list' ? (await client.listTools()).tools : await client.callTool(msg.args);
    port.postMessage({ type: 'result', id: msg.id, result });
  } catch {
    port.postMessage({ type: 'failure', id: msg.id });
  }
});
