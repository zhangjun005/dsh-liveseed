import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-client-connection';
import { z } from 'zod';
import { CompanionError } from '../../core/protocol.js';
import type { CompanionRuntime } from './runtime.js';

const sendSchema = z.object({ requestId: z.string().uuid(), text: z.string().trim().min(1).max(6000) }).strict();
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}
async function bodyOf(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new CompanionError(415, '请使用面板发送消息。');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 32768) throw new CompanionError(413, '这条消息太长了，请分开说。');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new CompanionError(400, '消息格式有误，请重新发送。'); }
}
/** Every route uses host authentication and serves only the one owned companion. */
export function registerHttp(ctx: Context, runtime: CompanionRuntime): void {
  for (const action of ['state', 'send', 'stop', 'memory-state', 'memory-send', 'memory-stop'] as const) {
    ctx.webServer.register({ kind: 'exact', path: `/liveseed/api/${action}`, handler: async (request, response) => {
      const admission = ctx.connection.admit(request);
      if ('rejection' in admission) { json(response, admission.rejection, { error: '请先登录 DSH。' }); return; }
      if (request.headers['x-liveseed-request'] !== '1') { json(response, 403, { error: '请通过德谬歌面板访问。' }); return; }
      const expectedMethod = action.endsWith('state') ? 'GET' : 'POST';
      if (request.method !== expectedMethod) { response.setHeader('allow', expectedMethod); json(response, 405, { error: '不支持此操作。' }); return; }
      try {
        if (action === 'state') json(response, 200, await runtime.state());
        else if (action === 'memory-state') json(response, 200, await runtime.memoryState());
        else if (action === 'memory-send') json(response, 202, await runtime.sendMemory(sendSchema.parse(await bodyOf(request))));
        else if (action === 'memory-stop') { z.object({}).strict().parse(await bodyOf(request)); await runtime.stopMemory(); json(response, 200, { stopped: true }); }
        else if (action === 'send') json(response, 202, await runtime.send(sendSchema.parse(await bodyOf(request))));
        else { z.object({}).strict().parse(await bodyOf(request)); await runtime.stop(); json(response, 200, { stopped: true }); }
      } catch (error) {
        if (error instanceof CompanionError) json(response, error.status, { error: error.message });
        else if (error instanceof z.ZodError) json(response, 400, { error: '请输入有效消息，最多 6000 字。' });
        else { ctx.logger.warn('LiveSeed panel request failed.'); json(response, 503, { error: '暂时连接不上，请稍后再试。' }); }
      }
    } });
  }
}
