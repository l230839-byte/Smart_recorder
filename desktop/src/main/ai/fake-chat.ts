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
    if (request.task === 'chat-plan') {
      const question = /NEW QUESTION: (.*)$/s.exec(prompt)?.[1]?.trim() ?? '';
      return JSON.stringify({ search: question ? [question] : [], from_minute: null, to_minute: null, overview: false });
    }
    if (request.task === 'chat') {
      // The lines sharing the most words with the question, quoted with their real ids.
      const question = /QUESTION: (.*)$/s.exec(prompt)?.[1]?.trim() ?? '';
      const words = new Set(question.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3));
      const scored = found
        .map((l) => ({ ...l, score: l.text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => words.has(w)).length }))
        .filter((l) => l.score > 0)
        .sort((a, b) => b.score - a.score || a.id - b.id)
        .slice(0, 3);
      if (!scored.length) return JSON.stringify({ answer: 'Demo answer: no transcript line shares words with this question, so the recordings may not cover it.', found: 'no', general: '' });
      const list = scored.map((l) => `- ${l.text} [S${l.id}]`).join('\n');
      return JSON.stringify({ answer: `Demo answer. These lines match your question best:\n\n${list}`, found: 'partly', general: '' });
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
