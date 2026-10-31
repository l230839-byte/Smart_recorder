import type { ChatProvider, ChatRequest, ChatResult } from './types';

const LINE = /^\[S(\d+) [\d:]+\] (.*)$/gm;

function lines(request: ChatRequest): { id: number; text: string }[] {
  const prompt = request.messages[request.messages.length - 1]!.content;
  return [...prompt.matchAll(LINE)].map((m) => ({ id: Number(m[1]), text: m[2]! }));
}

/**
 * A demo model with no network. It quotes transcript lines with real citations rather than pretending
 * to understand them, so its output is obviously a demo while every downstream step still runs.
 */
export class FakeChatProvider implements ChatProvider {
  constructor(private readonly delayMs = 100) {}

  async complete(request: ChatRequest): Promise<ChatResult> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, this.delayMs);
      request.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Canceled', 'AbortError'));
      });
    });
    return { text: this.reply(request), truncated: false, inputTokens: 0, outputTokens: 0, rate: null };
  }

  private reply(request: ChatRequest): string {
    const found = lines(request);
    const prompt = request.messages[request.messages.length - 1]!.content;

    if (request.task === 'chapters') {
      const step = Math.max(1, Math.ceil(found.length / 3));
      const chapters = found.filter((_, i) => i % step === 0).map((l, i) => ({ title: `Demo chapter ${i + 1}`, summary: l.text.slice(0, 80), start: l.id }));
      return JSON.stringify({ chapters });
    }
    if (request.task === 'suggest') {
      return JSON.stringify({ title: `Demo title: ${found[0]?.text.slice(0, 40) ?? 'Recording'}`, tags: ['demo', 'placeholder'], topics: ['Demo topic'] });
    }
    if (prompt.includes('NOTES:')) {
      const cited = [...prompt.matchAll(/^- .*$/gm)].map((m) => m[0]);
      return `# Demo summary\n\nThis is placeholder text from the demo AI, combined from notes.\n\n${cited.join('\n')}`;
    }
    const bullets = found.slice(0, 12).map((l) => `- ${l.text} [S${l.id}]`);
    return `# Demo summary\n\nThis is placeholder text from the demo AI. It quotes the transcript instead of understanding it.\n\n${bullets.join('\n')}`;
  }

  async testConnection(): Promise<void> {}
}
