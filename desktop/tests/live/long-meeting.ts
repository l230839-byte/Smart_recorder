import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * A long "operations review day": many short sessions, each read by two Windows voices, each with one
 * fact, one decision and one action item that can be checked, and a known start time. It tests what a
 * one- to three-hour recording needs: parts, rate limits, recall from the start, middle and end, and
 * timestamps that stay true across part boundaries. Everything is generated here.
 */
export interface Session {
  topic: string;
  presenter: string;
  city: string;
  /** Said early in the session; a pattern for checking it later. */
  fact: string;
  factPattern: RegExp;
  decision: string;
  action: string;
  actionOwner: string;
  nouns: string[];
}

export const SESSIONS: Session[] = [
  { topic: 'warehouse robotics', presenter: 'Marco', city: 'Rotterdam', fact: 'The Rotterdam pilot cut picking time by 23 percent.', factPattern: /23\s*(%|percent)|twenty.three percent/i, decision: 'We decided to extend the robots to the Hamburg warehouse in spring.', action: 'Marco will send the maintenance cost report by Friday.', actionOwner: 'Marco', nouns: ['picking routes', 'charging stations', 'shelf scanners', 'night shifts', 'safety zones', 'spare parts'] },
  { topic: 'the solar roof program', presenter: 'Priya', city: 'Seville', fact: 'The Seville roofs produced 410 megawatt hours last year.', factPattern: /410\s*(megawatt|mwh)|four hundred (and )?ten megawatt/i, decision: 'We decided to add battery storage to the two largest sites.', action: 'Priya will collect three quotes for batteries by the end of the month.', actionOwner: 'Priya', nouns: ['panel cleaning', 'inverters', 'grid contracts', 'roof inspections', 'weather data', 'installation crews'] },
  { topic: 'the customer support chatbot', presenter: 'Tomasz', city: 'Krakow', fact: 'The chatbot now answers 61 percent of questions without a person.', factPattern: /61\s*(%|percent)|sixty.one percent/i, decision: 'We decided to keep a person on every refund request.', action: 'Tomasz will write the new escalation guide by Wednesday.', actionOwner: 'Tomasz', nouns: ['refund requests', 'response times', 'handover messages', 'satisfaction surveys', 'language support', 'weekend coverage'] },
  { topic: 'employee onboarding', presenter: 'Hannah', city: 'Dublin', fact: 'New staff in Dublin now reach full speed in 19 days instead of 30.', factPattern: /19 days|nineteen days/i, decision: 'We decided to give every new hire a mentor for the first month.', action: 'Hannah will update the welcome handbook by next Monday.', actionOwner: 'Hannah', nouns: ['welcome sessions', 'laptop setup', 'mentors', 'training videos', 'first week tasks', 'feedback forms'] },
  { topic: 'data center cooling', presenter: 'Kenji', city: 'Osaka', fact: 'The Osaka hall lowered its cooling energy by 17 percent with outside air.', factPattern: /17\s*(%|percent)|seventeen percent/i, decision: 'We decided to replace the oldest chillers next year.', action: 'Kenji will share the temperature logs with the facilities team by Thursday.', actionOwner: 'Kenji', nouns: ['chillers', 'airflow', 'server racks', 'humidity', 'filters', 'temperature sensors'] },
  { topic: 'electric delivery vans', presenter: 'Fatima', city: 'Casablanca', fact: 'Forty electric vans in Casablanca saved 96 thousand liters of diesel.', factPattern: /96,?000|96 thousand|ninety.six thousand/i, decision: 'We decided to order twenty more vans for the summer.', action: 'Fatima will check charger capacity at the depot by Tuesday.', actionOwner: 'Fatima', nouns: ['charging time', 'route planning', 'driver training', 'battery health', 'depot space', 'winter range'] },
  { topic: 'mobile banking security', presenter: 'Lucas', city: 'Sao Paulo', fact: 'Fraud attempts on the Sao Paulo app fell by 44 percent after face login.', factPattern: /44\s*(%|percent)|forty.four percent/i, decision: 'We decided to require face login for transfers above one thousand reais.', action: 'Lucas will brief the call center on the new login steps by Friday.', actionOwner: 'Lucas', nouns: ['face login', 'transfer limits', 'device checks', 'password resets', 'alerts', 'app reviews'] },
  { topic: 'the coffee supply chain', presenter: 'Amara', city: 'Nairobi', fact: 'Our Nairobi partners delivered 1200 tonnes of coffee this season.', factPattern: /1,?200\s*(tonnes|tons|t\b)|twelve hundred tonnes/i, decision: 'We decided to pay farmers within ten days of delivery.', action: 'Amara will visit the three main cooperatives in March.', actionOwner: 'Amara', nouns: ['cooperatives', 'harvest timing', 'shipping containers', 'quality grading', 'farmer payments', 'storage humidity'] },
  { topic: 'hospital shift scheduling', presenter: 'Elena', city: 'Milan', fact: 'Overtime at the Milan hospital dropped by 31 percent with the new rota.', factPattern: /31\s*(%|percent)|thirty.one percent/i, decision: 'We decided to let nurses swap shifts in the app without approval.', action: 'Elena will train the ward managers on the rota tool by next Wednesday.', actionOwner: 'Elena', nouns: ['night shifts', 'shift swaps', 'ward managers', 'holiday requests', 'sick cover', 'rota rules'] },
  { topic: 'the recycling plant', presenter: 'Oskar', city: 'Gothenburg', fact: 'The Gothenburg plant now sorts 85 tonnes of plastic every day.', factPattern: /85\s*(tonnes|tons|t\b)|eighty.five tonnes/i, decision: 'We decided to add a second optical sorter in the autumn.', action: 'Oskar will get the permit paperwork started this week.', actionOwner: 'Oskar', nouns: ['optical sorters', 'conveyor belts', 'bale quality', 'collection trucks', 'contamination', 'buyers'] },
  { topic: 'tablets for schools', presenter: 'Grace', city: 'Accra', fact: 'We gave 3500 tablets to schools around Accra.', factPattern: /3,?500 tablets|thirty.five hundred tablets/i, decision: 'We decided to add offline lessons for areas with weak internet.', action: 'Grace will survey the teachers about the tablets by the end of term.', actionOwner: 'Grace', nouns: ['offline lessons', 'teacher training', 'screen repairs', 'charging carts', 'parent meetings', 'reading apps'] },
  { topic: 'wind farm maintenance', presenter: 'Callum', city: 'Aberdeen', fact: 'Drone checks near Aberdeen found blade damage on 7 turbines.', factPattern: /7 turbines|seven turbines/i, decision: 'We decided to repair the seven turbines before winter.', action: 'Callum will book the repair crane by the fifteenth.', actionOwner: 'Callum', nouns: ['blade inspections', 'gearboxes', 'crane bookings', 'weather windows', 'spare blades', 'vibration data'] },
  { topic: 'retail store layout', presenter: 'Sofia', city: 'Lisbon', fact: 'The new layout in Lisbon raised average basket size by 12 euros.', factPattern: /12 euros|twelve euros|€\s*12/i, decision: 'We decided to roll the layout out to five more stores.', action: 'Sofia will photograph the final layout for the other managers by Monday.', actionOwner: 'Sofia', nouns: ['shelf heights', 'checkout queues', 'promotions', 'lighting', 'fresh produce', 'signage'] },
  { topic: 'cyber security training', presenter: 'David', city: 'Toronto', fact: 'Phishing clicks in Toronto went down from 14 percent to 3 percent.', factPattern: /14\s*(%|percent)[^.]*3\s*(%|percent)|fourteen percent[^.]*three percent/i, decision: 'We decided to run a phishing test every quarter.', action: 'David will send the next training module to all staff by the first of the month.', actionOwner: 'David', nouns: ['phishing tests', 'password managers', 'training modules', 'incident reports', 'laptop updates', 'access reviews'] },
  { topic: 'water leak sensors', presenter: 'Ayesha', city: 'Lahore', fact: 'Sensors in Lahore found 260 leaks in the first six months.', factPattern: /260 leaks|two hundred (and )?sixty leaks/i, decision: 'We decided to put sensors on every main pipe in the old city.', action: 'Ayesha will present the leak map to the city council next Tuesday.', actionOwner: 'Ayesha', nouns: ['pipe pressure', 'leak maps', 'repair teams', 'sensor batteries', 'night flows', 'meter readings'] },
  { topic: 'food waste in kitchens', presenter: 'Pierre', city: 'Lyon', fact: 'Our Lyon kitchens throw away 38 percent less food than last year.', factPattern: /38\s*(%|percent)|thirty.eight percent/i, decision: 'We decided to donate unsold bread to the shelter every evening.', action: 'Pierre will sign the agreement with the shelter by Friday.', actionOwner: 'Pierre', nouns: ['portion sizes', 'menu planning', 'stock rotation', 'donations', 'compost', 'supplier orders'] },
  { topic: 'the translation service', presenter: 'Mei', city: 'Taipei', fact: 'The Taipei team translated 2 million words for clients this year.', factPattern: /(2|two)\s*(million|m)\s*words/i, decision: 'We decided to add Vietnamese and Thai next quarter.', action: 'Mei will hire two reviewers for the new languages by June.', actionOwner: 'Mei', nouns: ['reviewers', 'glossaries', 'deadlines', 'machine drafts', 'client feedback', 'style guides'] },
  { topic: 'drone inspections of bridges', presenter: 'Rafael', city: 'Valencia', fact: 'Drones inspected 48 bridges around Valencia without closing a road.', factPattern: /48 bridges|forty.eight bridges/i, decision: 'We decided to inspect every bridge twice a year from now on.', action: 'Rafael will renew the drone flight permits by the end of next week.', actionOwner: 'Rafael', nouns: ['flight permits', 'crack detection', 'image storage', 'pilot training', 'traffic plans', 'battery swaps'] },
  { topic: 'the payroll migration', presenter: 'Ingrid', city: 'Oslo', fact: 'The Oslo payroll moved to the new system with zero late payments.', factPattern: /zero late|no late payments|0 late/i, decision: 'We decided to move the other Nordic offices in January.', action: 'Ingrid will freeze payroll changes for the last week of December.', actionOwner: 'Ingrid', nouns: ['tax tables', 'bank files', 'pay slips', 'holiday pay', 'test runs', 'data checks'] },
  { topic: 'call center staffing', presenter: 'Juan', city: 'Bogota', fact: 'Average waiting time in Bogota fell to 90 seconds.', factPattern: /90 seconds|ninety seconds|1\.5 minutes|minute and a half/i, decision: 'We decided to open a second evening shift.', action: 'Juan will post the job ads for evening agents by Wednesday.', actionOwner: 'Juan', nouns: ['evening shifts', 'call volumes', 'agent training', 'headsets', 'quality checks', 'callback requests'] },
  { topic: 'smart parking', presenter: 'Nadia', city: 'Tunis', fact: 'Smart parking in Tunis cut the time drivers spend searching by 9 minutes.', factPattern: /9 minutes|nine minutes/i, decision: 'We decided to add the parking map to the city transport app.', action: 'Nadia will meet the transport app team on the twentieth.', actionOwner: 'Nadia', nouns: ['parking sensors', 'payment kiosks', 'street signs', 'occupancy data', 'fines', 'resident permits'] },
  { topic: 'warehouse safety', presenter: 'Ben', city: 'Manchester', fact: 'Manchester went 200 days without a lost-time injury.', factPattern: /200 days|two hundred days/i, decision: 'We decided to give every forklift a speed limiter.', action: 'Ben will order the speed limiters by the end of the month.', actionOwner: 'Ben', nouns: ['forklifts', 'walkways', 'safety boots', 'near misses', 'lighting', 'first aid'] },
  { topic: 'battery recycling', presenter: 'Lin', city: 'Shenzhen', fact: 'The Shenzhen line recovers 92 percent of the lithium from old batteries.', factPattern: /92\s*(%|percent)|ninety.two percent/i, decision: 'We decided to build a second line next to the first.', action: 'Lin will send the equipment list to purchasing by Thursday.', actionOwner: 'Lin', nouns: ['lithium recovery', 'battery sorting', 'fire safety', 'shredders', 'chemical baths', 'collection points'] },
  { topic: 'rural internet', presenter: 'Samuel', city: 'Kampala', fact: 'We connected 140 villages near Kampala this year.', factPattern: /140 villages|one hundred (and )?forty villages/i, decision: 'We decided to use solar powered towers in the next region.', action: 'Samuel will finish the site survey for the next region by August.', actionOwner: 'Samuel', nouns: ['radio towers', 'solar power', 'village agents', 'data plans', 'tower security', 'signal strength'] },
  { topic: 'video streaming costs', presenter: 'Olivia', city: 'Sydney', fact: 'The Sydney team cut streaming bandwidth costs by 27 percent.', factPattern: /27\s*(%|percent)|twenty.seven percent/i, decision: 'We decided to switch to the newer video format for all new uploads.', action: 'Olivia will test the new format on older phones by next Friday.', actionOwner: 'Olivia', nouns: ['video formats', 'bandwidth', 'older phones', 'storage tiers', 'live events', 'buffering'] },
  { topic: 'fleet fuel efficiency', presenter: 'Viktor', city: 'Warsaw', fact: 'Our Warsaw trucks now average 29 liters per hundred kilometers.', factPattern: /29\s*(liters|litres|l\b)|twenty.nine lit/i, decision: 'We decided to reward the five most efficient drivers every month.', action: 'Viktor will publish the first driver ranking next month.', actionOwner: 'Viktor', nouns: ['tire pressure', 'idling', 'driver rankings', 'route lengths', 'engine checks', 'fuel cards'] },
  { topic: 'the office relocation', presenter: 'Chloe', city: 'Paris', fact: 'The new Paris office will open on the second of May.', factPattern: /(2nd|second) of may|may (2|second)/i, decision: 'We decided to keep the old office for one extra month as a backup.', action: 'Chloe will send the moving schedule to all teams by Monday.', actionOwner: 'Chloe', nouns: ['moving boxes', 'meeting rooms', 'desk booking', 'internet lines', 'parking', 'keys and badges'] },
  { topic: 'crop irrigation', presenter: 'Arjun', city: 'Pune', fact: 'Drip irrigation near Pune saved 35 percent of the water.', factPattern: /35\s*(%|percent)|thirty.five percent/i, decision: 'We decided to offer farmers loans for drip systems.', action: 'Arjun will prepare the loan terms with the bank by the tenth.', actionOwner: 'Arjun', nouns: ['drip lines', 'soil moisture', 'pump schedules', 'farmer loans', 'crop yields', 'water rights'] },
  { topic: 'fraud detection', presenter: 'Emma', city: 'Amsterdam', fact: 'The Amsterdam model flagged 1800 fraudulent orders last quarter.', factPattern: /1,?800 (fraudulent )?orders|eighteen hundred/i, decision: 'We decided to review flagged orders within one hour.', action: 'Emma will add two analysts to the review team by next month.', actionOwner: 'Emma', nouns: ['flagged orders', 'false alarms', 'card checks', 'review queues', 'chargebacks', 'customer emails'] },
  { topic: 'next year\'s conference', presenter: 'Daniel', city: 'Cape Town', fact: 'Next year\'s conference will be in Cape Town on the ninth of October.', factPattern: /cape town[^.]*((9th|ninth|9)( of)? october|october (9|ninth))/i, decision: 'We decided to stream every talk online for free.', action: 'Daniel will book the conference hall by the end of the quarter.', actionOwner: 'Daniel', nouns: ['speakers', 'ticket prices', 'live streams', 'hotel deals', 'sponsors', 'workshops'] },
];

export const NUMBER_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'twenty one', 'twenty two', 'twenty three', 'twenty four', 'twenty five', 'twenty six', 'twenty seven', 'twenty eight', 'twenty nine', 'thirty'];

/** Ordinary discussion, so each session sounds like talk and not a list of facts. */
const FILLER: ((n: string[], s: Session) => string)[] = [
  (n, s) => `When we started looking at ${s.topic}, the first thing we noticed was how much time went into ${n[0]}.`,
  (n, s) => `In ${s.city}, the local team tried a new approach to ${n[1]}, and the early feedback was encouraging.`,
  (n) => `Several people raised the cost of ${n[2]}, especially during the busy season.`,
  (n) => `We compared three suppliers for ${n[3]}, and the differences were bigger than we expected.`,
  (n) => `The second phase will focus on ${n[4]}, which depends on what we learn in the first phase.`,
  (n) => `Customers told us that ${n[0]} mattered more to them than price.`,
  (n) => `We also need clearer reporting on ${n[5]}, so managers can see problems earlier.`,
  (n) => `Training matters here, because ${n[1]} only works when everyone follows the same steps.`,
  (n) => `Looking at last year, ${n[2]} improved steadily, but not evenly across regions.`,
  (n) => `There was a short discussion about whether ${n[3]} should go to an outside partner.`,
  (n) => `The main lesson so far is that small changes to ${n[4]} add up over a full year.`,
  (n) => `Someone asked how ${n[5]} would affect existing contracts, and the answer was that nothing changes until the review is finished.`,
  (n) => `We will keep measuring ${n[0]} every month and share the results with this group.`,
  (n, s) => `The team in ${s.city} wants more time to test ${n[1]} before we make it standard.`,
  (n) => `A few problems with ${n[2]} came from old equipment rather than from the new process.`,
  (n) => `We wrote down every complaint about ${n[3]} and grouped them into four themes.`,
  (n) => `The quickest win was simply explaining ${n[4]} better to the people who use it every day.`,
  (n) => `It is too early to say whether ${n[5]} will save money, but the signs are good.`,
  (n, s) => `If ${s.topic} works as planned, other sites will want to copy what we did with ${n[0]}.`,
  (n) => `Nobody expected ${n[1]} to be the hardest part, but it was.`,
];

function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The lines of one session, as [voice, text]. Zira presents; David chairs. */
export function sessionLines(index: number, fillerCount: number): ['Zira' | 'David', string][] {
  const s = SESSIONS[index % SESSIONS.length]!;
  const rnd = random(index + 1);
  const lines: ['Zira' | 'David', string][] = [
    ['David', `Session ${NUMBER_WORDS[index] ?? index + 1}. The topic is ${s.topic}, presented by ${s.presenter} from ${s.city}.`],
    ['Zira', `Thank you. I will talk about ${s.topic} and what we learned this year. ${s.fact}`],
  ];
  for (let i = 0; i < fillerCount; i++) {
    const nouns = [...s.nouns].sort(() => rnd() - 0.5);
    lines.push([i % 5 === 4 ? 'David' : 'Zira', FILLER[Math.floor(rnd() * FILLER.length)]!(nouns, s)]);
    if (i === Math.floor(fillerCount / 2)) lines.push(['David', `${s.decision} ${s.action}`]);
  }
  lines.push(['David', `Thank you ${s.presenter}. Let's move on.`]);
  return lines;
}

function wavSeconds(file: string): number {
  return (statSync(file).size - 44) / 32000;
}

function speak(files: { out: string; lines: ['Zira' | 'David', string][] }[], workDir: string): void {
  const body = files
    .map(({ out, lines }) => [`$s.SetOutputToWaveFile('${out.replace(/'/g, "''")}', $format)`, ...lines.map(([v, t]) => `$s.SelectVoice('Microsoft ${v} Desktop'); $s.Speak('${t.replace(/'/g, "''")}')`), '$s.SetOutputToNull()'].join('\n'))
    .join('\n');
  const script = `Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
${body}
$s.Dispose()`;
  const scriptFile = join(workDir, 'speak-long.ps1');
  writeFileSync(scriptFile, script, 'utf8');
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], { encoding: 'utf8', maxBuffer: 1 << 24 });
  if (result.status !== 0) throw new Error(`Could not generate speech: ${result.stderr}`);
}

export interface LongAudio {
  file: string;
  durationMs: number;
  /** Where each session starts in the final audio. */
  sessionStartsMs: number[];
  sessions: number;
}

/**
 * Builds about `minutes` of meeting as one AAC (.m4a) file, the format phones record in. Cached in
 * `workDir`, since three hours of speech takes a while to generate.
 */
export function makeLongMeeting(workDir: string, minutes: number): LongAudio {
  const manifest = join(workDir, `long-${minutes}.json`);
  if (existsSync(manifest)) {
    const cached = JSON.parse(readFileSync(manifest, 'utf8')) as LongAudio;
    if (existsSync(cached.file)) return cached;
  }
  const sessions = Math.min(SESSIONS.length, Math.max(2, Math.round(minutes / 6)));
  // Calibrate: one session at a known length, then size the rest to reach the target.
  const probe = join(workDir, 'probe.wav');
  speak([{ out: probe, lines: sessionLines(0, 20) }], workDir);
  const perFiller = (wavSeconds(probe) - 12) / 20;
  const fillerCount = Math.max(4, Math.round(((minutes * 60) / sessions - 12) / perFiller));

  const parts = Array.from({ length: sessions }, (_, i) => ({ out: join(workDir, `session-${String(i).padStart(2, '0')}.wav`), lines: sessionLines(i, fillerCount) }));
  speak(parts, workDir);

  const sessionStartsMs: number[] = [];
  let at = 0;
  for (const p of parts) {
    sessionStartsMs.push(Math.round(at * 1000));
    at += wavSeconds(p.out);
  }
  const list = join(workDir, 'sessions.txt');
  writeFileSync(list, parts.map((p) => `file '${p.out.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
  const file = join(workDir, `long-meeting-${minutes}.m4a`);
  const ffmpeg = resolve('resources/bin/ffmpeg.exe');
  const result = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'aac', '-b:a', '64k', '-ac', '1', file], { encoding: 'utf8' });
  if (result.status !== 0 || !existsSync(file)) throw new Error(`Could not encode the long meeting: ${result.stderr}`);
  const audio: LongAudio = { file, durationMs: Math.round(at * 1000), sessionStartsMs, sessions };
  writeFileSync(manifest, JSON.stringify(audio, null, 2), 'utf8');
  return audio;
}

/** Questions whose answers sit at the start, middle and end, plus one that is not there. */
export function longQuestions(sessions: number): { question: string; pattern: RegExp | null; session: number | null }[] {
  const pick = [1, Math.floor(sessions / 2), sessions - 1];
  const ask: Record<number, string> = {};
  for (const i of pick) {
    const s = SESSIONS[i]!;
    ask[i] = `What result did ${s.presenter} report about ${s.topic}?`;
  }
  return [
    ...pick.map((i) => ({ question: ask[i]!, pattern: SESSIONS[i]!.factPattern, session: i })),
    { question: `Who will ${SESSIONS[Math.floor(sessions / 3)]!.action.split(' will ')[1]!.replace(/\.$/, '')}?`, pattern: new RegExp(SESSIONS[Math.floor(sessions / 3)]!.actionOwner, 'i'), session: Math.floor(sessions / 3) },
    { question: 'What did they decide about the marketing budget for television ads?', pattern: null, session: null },
  ];
}
