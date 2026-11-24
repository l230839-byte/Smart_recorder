import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { ChatHttpProvider } from './chat-http';
import { ProviderError, type ChatProvider, type ChatRequest, type ChatResult } from './types';

/** A free port on this computer only. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No free port.'))));
    });
  });
}

export interface LocalLlmOptions {
  exe: string;
  modelPath: (model: string) => string | null;
  threads: number;
  /** Tokens of context. Enough for a transcript piece, its instructions and a long answer. */
  contextTokens?: number;
  /** The model is unloaded after this long unused, to give its memory back. */
  idleMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * llama.cpp's server, run by EchoMind on 127.0.0.1 only, on a random free port, for one model at a time.
 * It starts when offline writing is first needed (loading a model takes seconds), stays up while in use,
 * and stops after a while idle or when EchoMind quits.
 */
export class LocalLlmServer {
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private model: string | null = null;
  private starting: Promise<string> | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: LocalLlmOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  get installed(): boolean {
    return existsSync(this.options.exe);
  }

  /** The address of a server running `model`, starting or switching it if needed. */
  async ensure(model: string): Promise<string> {
    this.touch();
    if (this.url && this.model === model && this.child && this.child.exitCode === null) return this.url;
    if (this.starting && this.model === model) return this.starting;
    this.stop();
    this.model = model;
    this.starting = this.start(model).finally(() => (this.starting = null));
    return this.starting;
  }

  private async start(model: string): Promise<string> {
    const path = this.options.modelPath(model);
    if (!this.installed) throw new ProviderError('rejected', 'Offline writing is not installed in this copy of EchoMind.');
    if (!path || !existsSync(path)) throw new ProviderError('rejected', 'Download the offline writing model first, in Settings > AI providers.');
    const port = await freePort();
    const args = ['--model', path, '--host', '127.0.0.1', '--port', String(port), '--ctx-size', String(this.options.contextTokens ?? 16_384), '--threads', String(this.options.threads), '--parallel', '1', '--no-webui', '--jinja', '--reasoning', 'off'];
    const child = spawn(this.options.exe, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    const exited = new Promise<never>((_, reject) =>
      child.once('exit', (code) => {
        if (this.child === child) this.child = null;
        this.url = null;
        reject(new ProviderError('rejected', /memory|alloc/i.test(stderr) ? 'This computer does not have enough free memory for this model. Choose the smaller one in Settings > AI providers.' : `Offline writing stopped unexpectedly (code ${code}).`));
      }),
    );
    exited.catch(() => undefined);
    const url = `http://127.0.0.1:${port}`;
    // Loading a model of a few GB from disk takes seconds; the server answers /health with 200 when ready.
    const deadline = Date.now() + 3 * 60_000;
    while (Date.now() < deadline) {
      const ready = await Promise.race([
        this.fetchFn(`${url}/health`).then(
          (r) => r.ok,
          () => false,
        ),
        exited,
      ]);
      if (ready) {
        this.url = `${url}/v1`;
        return this.url;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.stop();
    throw new ProviderError('server', 'The offline writing model took too long to load. EchoMind will try again.');
  }

  /** Keeps the model loaded while it is being used; unloads it after the idle time. */
  touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), this.options.idleMs ?? 10 * 60_000);
    this.idle.unref?.();
  }

  stop(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.child?.kill();
    this.child = null;
    this.url = null;
  }
}

/**
 * The offline writing provider: the same OpenAI-compatible conversation as Groq or Gemini, with a server
 * on this computer. Requests are slower than online, so each may take up to half an hour.
 */
export class LocalLlmProvider implements ChatProvider {
  constructor(
    private readonly server: LocalLlmServer,
    private readonly extraBody: (model: string) => Record<string, unknown>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async complete(request: ChatRequest): Promise<ChatResult> {
    const url = await this.server.ensure(request.model);
    try {
      return await new ChatHttpProvider(url, null, this.fetchFn, 30 * 60_000, this.extraBody).complete(request);
    } finally {
      this.server.touch();
    }
  }

  async listModels(): Promise<string[]> {
    return [];
  }

  async testConnection(): Promise<void> {
    if (!this.server.installed) throw new Error('Offline writing is not installed in this copy of EchoMind.');
  }
}
