import { Worker } from 'node:worker_threads';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { CanvasHttp } from './canvas-http.js';
import { safeError, ServiceError } from './shared.js';
import { PreviewStore } from './previews.js';

type Inputs = Record<string, unknown>;
export class Catalog {
  private worker?: Worker;
  private index?: Promise<Tool[]>;
  private calls = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private sequence = 0;
  private previews = new PreviewStore();
  constructor(private http: CanvasHttp, private identity: () => Promise<string>) {}

  private start() {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./catalog-worker.js', import.meta.url));
    this.worker = worker;
    worker.on('message', async msg => {
      if (msg.type === 'http') {
        let reply;
        try { reply = await this.http.request(msg.args); }
        catch (e) { reply = { status: 503, body: JSON.stringify({ message: safeError(e).message }), headers: { 'content-type': 'application/json' } }; }
        worker.postMessage({ type: 'httpReply', id: msg.id, reply });
        return;
      }
      const call = this.calls.get(msg.id);
      this.calls.delete(msg.id);
      if (msg.type === 'result') call?.resolve(msg.result);
      else call?.reject(new ServiceError('CANVAS_ERROR', 'Canvas could not complete the operation.'));
    });
    const stopped = () => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.index = undefined;
      for (const call of this.calls.values()) call.reject(new ServiceError('CATALOG_UNAVAILABLE', 'The Canvas catalog stopped. Inspect the current state before retrying.'));
      this.calls.clear();
    };
    worker.on('error', stopped);
    worker.on('exit', stopped);
    return worker;
  }

  private rpc<T>(type: 'list' | 'call', args?: unknown): Promise<T> {
    const worker = this.start();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve: r => resolve(r as T), reject });
      worker.postMessage({ id, type, args });
    });
  }

  list() { return this.index ??= this.rpc<Tool[]>('list'); }
  async find(name: string) {
    const tool = (await this.list()).find(t => t.name === name);
    if (!tool) throw new ServiceError('UNKNOWN_TOOL', 'Use canvas_search_tools to find an operation.');
    return tool;
  }
  async read(name: string, args: Inputs) {
    const tool = await this.find(name);
    if (!tool.annotations?.readOnlyHint) throw new ServiceError('PREVIEW_REQUIRED', 'Use canvas_prepare_action for changes.');
    return this.rpc<CallToolResult>('call', { name, arguments: args });
  }
  async prepare(name: string, args: Inputs) {
    const tool = await this.find(name);
    if (tool.annotations?.readOnlyHint) throw new ServiceError('READ_ONLY', 'Use canvas_read_tool for this operation.');
    const { token, expiresAt } = this.previews.create('canvas', await this.identity(), { name, args });
    const display = { ...args };
    if (typeof args.content_base64 === 'string') {
      const { createHash } = await import('node:crypto');
      const bytes = Buffer.from(args.content_base64, 'base64');
      display.content_base64 = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    return { name, arguments: display, confirmationToken: token, expiresAt };
  }
  async confirm(token: string, confirmed: boolean) {
    const { payload } = this.previews.consume<{ name: string; args: Inputs }>(token, 'canvas', await this.identity(), confirmed);
    return this.rpc<CallToolResult>('call', { name: payload.name, arguments: payload.args });
  }
  async close() { await this.worker?.terminate(); this.previews.clear(); }
}
