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
    if (request.task === 'studio-json') return studioJson(prompt, found);
    if (request.task === 'studio') {
      if (request.messages[0]!.content.startsWith('You translate documents')) return `Demo translation (not a real translation):\n\n${prompt.replace(/^Translate into [^:]+:\s*/, '')}`;
      return `# Demo result\n\nThis is placeholder text from the demo AI. It quotes the transcript instead of understanding it.\n\n${found
        .slice(0, 8)
        .map((l) => `- ${l.text} [S${l.id}]`)
        .join('\n')}`;
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

/** Demo Studio material built from the transcript lines, in the shape each tool asks for. */
function studioJson(prompt: string, found: { id: number; text: string }[]): string {
  const count = Number(/(?:Make|Write) (\d+) /.exec(prompt)?.[1] ?? 5);
  // Speaker names ("Speaker A: …") are context, not part of what was said.
  const lines = (found.length ? found : [{ id: 1, text: 'No transcript' }]).map((l) => ({ ...l, text: l.text.replace(/^[^:\]]{1,40}: /, '') }));
  const pick = (i: number) => lines[i % lines.length]!;
  if (prompt.includes('Shape: {"cards"')) {
    return JSON.stringify({ cards: Array.from({ length: Math.min(count, lines.length) }, (_, i) => ({ front: `Demo card ${i + 1}: what was said here?`, back: pick(i).text, source: pick(i).id, supplemental: false })) });
  }
  if (prompt.includes('Shape: {"questions"')) {
    const types = [...prompt.matchAll(/"(mcq|tf|short|long)" \(/g)].map((m) => m[1]!);
    return JSON.stringify({
      questions: Array.from({ length: Math.min(count, lines.length) }, (_, i) => {
        const type = types[i % types.length] ?? 'mcq';
        const l = pick(i);
        if (type === 'mcq') return { type, question: `Demo question ${i + 1}: which line was said?`, options: [l.text, 'Something else', 'Nothing at all', 'A different topic'], answer: l.text, explanation: 'Demo explanation quoting the transcript.', explanation_supplemental: false, source: l.id };
        if (type === 'tf') return { type, question: `Demo: the recording says "${l.text}"`, answer: 'True', explanation: 'It is a line of the transcript.', explanation_supplemental: false, source: l.id };
        return { type, question: `Demo question ${i + 1}: what does the recording say here?`, answer: l.text, explanation: '', explanation_supplemental: false, source: l.id };
      }),
    });
  }
  if (prompt.includes('Shape: {"root"')) {
    return JSON.stringify({ root: { label: 'Demo map', children: lines.slice(0, 4).map((l, i) => ({ label: `Demo branch ${i + 1}`, source: l.id, children: [{ label: l.text.slice(0, 40), source: l.id, children: [] }] })) } });
  }
  if (prompt.includes('Shape: {"tasks"')) {
    // Lines that read like commitments or requests become demo tasks.
    const tasks = lines.filter((l) => /\b(add|send|submit|will|should|must|prepare)\b/i.test(l.text)).map((l) => ({ title: `Demo: ${l.text.replace(/\.$/, '')}`, description: 'Found by the demo AI.', due_date: null, due_text: '', owner: '', priority: null, source: l.id }));
    return JSON.stringify({ tasks });
  }
  if (prompt.includes('Shape: {"lines"')) {
    return JSON.stringify({ lines: lines.map((l) => ({ id: l.id, text: `[Demo translation] ${l.text}` })) });
  }
  return '{}';
}
