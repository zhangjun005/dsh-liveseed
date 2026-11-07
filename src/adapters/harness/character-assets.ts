import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { CharacterCatalog, CharacterModel } from '../../core/character.js';

const RESOURCE = '/api/liveseed/character-resource';
const types: Record<string, string> = { '.pmx': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'image/bmp', '.tga': 'image/x-tga' };
const maximumBytes = 64 * 1024 * 1024;
function inside(root: string, target: string): boolean {
  const name = relative(root, target);
  return name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
}

/** Private, authenticated native Fetch route: only inventoried PMX/textures, never arbitrary paths. */
export class CharacterAssets {
  private readonly files = new Map<string, { path: string; root: string; type: string }>();
  private models: CharacterModel[] = [];
  readonly ready: Promise<void>;
  constructor(private readonly directory: string) { this.ready = this.scan(); }
  private async scan(): Promise<void> {
    let root: string;
    try { root = await realpath(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const paths: string[] = [];
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 8) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) await walk(path, depth + 1);
        else if (entry.isFile() && types[extname(entry.name).toLowerCase()]) paths.push(path);
        if (paths.length > 2000) throw new Error('Character asset directory contains too many files.');
      }
    };
    await walk(root, 0);
    const resources: { path: string; id: string; url: string }[] = [];
    for (const path of paths.sort()) {
      const canonical = await realpath(path);
      if (!inside(root, canonical)) continue;
      const info = await stat(canonical);
      if (!info.isFile() || info.size > maximumBytes) continue;
      const id = createHash('sha256').update(relative(root, path)).digest('hex');
      this.files.set(id, { path, root, type: types[extname(path).toLowerCase()]! });
      resources.push({ path, id, url: `${RESOURCE}?id=${id}` });
    }
    this.models = resources.filter(item => extname(item.path).toLowerCase() === '.pmx').map(item => {
      const folder = resolve(item.path, '..');
      return { id: item.id, title: basename(item.path, extname(item.path)), model: item.url,
        resources: resources.filter(resource => inside(folder, resource.path)).map(resource => ({ name: relative(folder, resource.path).split(sep).join('/'), url: resource.url })) };
    });
  }
  async catalog(): Promise<CharacterCatalog> { await this.ready; return { models: this.models }; }
  async fetch(request: Request): Promise<Response> {
    try { await this.ready; } catch { return new Response(null, { status: 503 }); }
    const id = new URL(request.url).searchParams.get('id') ?? '';
    const resource = /^[a-f0-9]{64}$/.test(id) ? this.files.get(id) : undefined;
    if (!resource) return new Response(null, { status: 404 });
    try {
      const canonical = await realpath(resource.path);
      if (!inside(resource.root, canonical)) return new Response(null, { status: 404 });
      const info = await stat(canonical);
      if (!info.isFile() || info.size > maximumBytes) return new Response(null, { status: 404 });
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(await readFile(canonical)), { headers: {
        'Content-Type': resource.type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      } });
    } catch { return new Response(null, { status: 404 }); }
  }
  install(ctx: Context): void {
    ctx.connection.fetch.register({ path: RESOURCE, methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: request => this.fetch(request) });
    const engine = resolve(createRequire(import.meta.url).resolve('@takahirox/three-mmd'), '../vendor/bullet');
    const engineFiles: Record<string, string> = { 'ammo.js': resolve(engine, 'ammo.js'), 'ammo.wasm': resolve(engine, 'ammo.wasm'),
      'physics-worker.js': resolve(engine, '../../animation/MMDPhysicsWorker.js') };
    for (const [name, path] of Object.entries(engineFiles)) ctx.connection.fetch.register({
      path: `/api/liveseed/character-engine/${name}`, methods: ['GET'], requestBody: 'buffered',
      fetch: async () => new Response(new Uint8Array(await readFile(path)), { headers: {
        'Content-Type': name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
        'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff',
      } }),
    });
  }
}
