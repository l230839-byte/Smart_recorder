import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A meeting read by two Windows voices, with facts that can be checked: dates, owners, numbers and
 * decisions. Everything below is generated here; nothing personal is sent anywhere.
 */
export const SCRIPT: [voice: 'Zira' | 'David', text: string][] = [
  ['Zira', 'Good morning everyone. This is the weekly product meeting for the Orion project.'],
  ['David', 'Thanks Sara. First item is the mobile release. We agreed to move the launch date to March fourteenth.'],
  ['Zira', 'Ahmed will finish the payment screen by Friday, and Lina will test it next Monday.'],
  ['David', 'The budget for cloud servers is twelve thousand dollars per month. We decided not to increase it this quarter.'],
  ['Zira', 'Second item is customer feedback. Users asked for dark mode and offline sync. Dark mode is approved for the next sprint.'],
  ['David', 'Offline sync is postponed, because the database migration is not ready.'],
  ['Zira', 'Action items. Ahmed sends the design review notes by Wednesday. Lina prepares the test plan. I will email the client about the new date.'],
  ['David', 'One risk. The app store review may take a week, so we need a buffer.'],
  ['Zira', 'Great. The next meeting is on Thursday at ten in the morning. Thank you all.'],
];

/** Facts a good transcript, summary or answer should contain, as patterns. */
export const FACTS: [name: string, pattern: RegExp][] = [
  ['Orion project', /orion/i],
  ['launch moved to March 14', /march\s*(14|fourteenth)|14(th)?\s*(of\s*)?march/i],
  ['Ahmed: payment screen by Friday', /ahmed[^.]*payment[^.]*friday|payment[^.]*ahmed[^.]*friday/i],
  ['Lina tests on Monday', /lina[^.]*(test|monday)/i],
  ['budget $12,000 per month', /12,?000|twelve thousand/i],
  ['budget not increased', /not (to )?increase|no increase|unchanged|stays|remain/i],
  ['dark mode approved', /dark mode[^.]*(approved|next sprint)/i],
  ['offline sync postponed', /offline sync[^.]*(postponed|delayed|deferred)/i],
  ['reason: migration not ready', /migration/i],
  ['design review notes by Wednesday', /design review[^.]*wednesday|wednesday[^.]*design review/i],
  ['app store review risk', /app store/i],
  ['next meeting Thursday 10am', /thursday[^.]*(10|ten)/i],
];

export const QUESTIONS = [
  'What was decided about offline sync, and why?',
  'Who is responsible for the payment screen, and when is it due?',
  'Did they discuss the marketing budget?',
  'What is the capital of France?',
];

export function makeSpeech(dir: string): string {
  const out = join(dir, 'orion-meeting.wav');
  const lines = SCRIPT.map(([voice, text]) => `$s.SelectVoice('Microsoft ${voice} Desktop'); $s.Speak('${text.replace(/'/g, "''")}'); Start-Sleep -Milliseconds 0`).join('\n');
  const script = `Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Rate = -1
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile('${out.replace(/'/g, "''")}', $format)
${lines}
$s.Dispose()`;
  const scriptFile = join(dir, 'speak.ps1');
  writeFileSync(scriptFile, script, 'utf8');
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], { encoding: 'utf8' });
  if (result.status !== 0 || !existsSync(out)) throw new Error(`Could not generate speech: ${result.stderr}`);
  return out;
}
