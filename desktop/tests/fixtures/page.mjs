import * as M from '../../node_modules/mediabunny/dist/bundles/mediabunny.mjs';
const { ipcRenderer } = require('electron');

const write = async (name, blob) => ipcRenderer.send('write', name, new Uint8Array(await blob.arrayBuffer()));

/** A tone with a silent gap in the middle, so skip-silence and waveforms have real structure. */
function wav(seconds, rate = 44100, silence = null) {
  const n = seconds * rate;
  const buffer = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buffer);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const quiet = silence && t >= silence[0] && t < silence[1];
    v.setInt16(44 + i * 2, quiet ? 0 : Math.sin(t * 2 * Math.PI * 440) * 12000 * (0.6 + 0.4 * Math.sin(t * 3)), true);
  }
  return new Blob([buffer]);
}

async function convert(blob, format, audio) {
  const target = new M.BufferTarget();
  const conversion = await M.Conversion.init({
    input: new M.Input({ source: new M.BlobSource(blob), formats: M.ALL_FORMATS }),
    output: new M.Output({ format, target }),
    audio,
    showWarnings: false,
  });
  if (!conversion.isValid) throw new Error('Invalid fixture conversion');
  await conversion.execute();
  return new Blob([target.buffer]);
}

/** Ten seconds of valid AMR-NB frames (12.2 kbps mode). */
function amr() {
  const frame = new Uint8Array(32);
  frame[0] = 0x3c;
  return new Blob([new TextEncoder().encode('#!AMR\n'), ...Array(500).fill(frame)]);
}

async function video() {
  const target = new M.BufferTarget();
  const output = new M.Output({ format: new M.WebMOutputFormat(), target });
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const videoSource = new M.CanvasSource(canvas, { codec: 'vp9', bitrate: 200_000 });
  const audioSource = new M.AudioBufferSource({ codec: 'opus', bitrate: 64_000 });
  output.addVideoTrack(videoSource);
  output.addAudioTrack(audioSource);
  await output.start();
  const buffer = new AudioBuffer({ length: 48000 * 3, sampleRate: 48000, numberOfChannels: 1 });
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.sin((i / 48000) * 2 * Math.PI * 330) * 0.4;
  await audioSource.add(buffer);
  for (let f = 0; f < 30; f++) {
    ctx.fillStyle = `hsl(${f * 12} 80% 50%)`;
    ctx.fillRect(0, 0, 64, 64);
    await videoSource.add(f / 10, 0.1);
  }
  await output.finalize();
  return new Blob([target.buffer]);
}

try {
  const source = wav(12, 44100, [4, 8]);
  await write('tone.wav', source);
  const opus = await convert(source, new M.OggOutputFormat(), { codec: 'opus', bitrate: 64000 });
  const aac = await convert(source, new M.Mp4OutputFormat(), { codec: 'aac', bitrate: 96000 });
  await write('voice-note.ogg', opus);
  await write('recorder.m4a', aac);
  // Same real format under the wrong name: the extension must not matter.
  await write('misnamed.mp3', opus);

  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  await write('silent.mp3', new Blob(Array(200).fill(frame)));

  await write('lecture-video.webm', await video());

  const bytes = new Uint8Array(await aac.arrayBuffer());
  await write('truncated.m4a', new Blob([bytes.slice(0, Math.floor(bytes.length / 2))]));
  const corrupt = bytes.slice();
  for (let i = 2000; i < corrupt.length - 2000; i++) corrupt[i] = (i * 31) & 255;
  await write('corrupt.m4a', new Blob([corrupt]));
  await write('fake.mp3', new Blob([new TextEncoder().encode('this is not audio '.repeat(2000))]));
  await write('old-phone.amr', amr());
  await write('empty.wav', new Blob([]));
  ipcRenderer.send('done');
} catch (e) {
  ipcRenderer.send('fail', String(e?.stack ?? e));
}
