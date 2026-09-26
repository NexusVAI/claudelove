// Loudness-normalise the synthesised mix (two-pass EBU R128) and encode the
// rendered frames into 1080p60 and 2160p60 MP4s.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out');
const DIST = path.join(ROOT, 'dist');
fs.mkdirSync(DIST, { recursive: true });
const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });

// pass 1: measure
const target = 'I=-15:TP=-1.2:LRA=11';
const probe = spawnSync('ffmpeg', ['-hide_banner', '-i', path.join(OUT, 'audio.wav'), '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-'], { encoding: 'utf8' });
const m = JSON.parse(probe.stderr.slice(probe.stderr.lastIndexOf('{'), probe.stderr.lastIndexOf('}') + 1));
console.log(`measured: I=${m.input_i} LUFS  TP=${m.input_tp} dBTP  LRA=${m.input_lra}`);
// pass 2: linear gain (no pumping)
const norm = path.join(OUT, 'audio_norm.wav');
ff(['-v', 'error', '-i', path.join(OUT, 'audio.wav'), '-af',
  `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`,
  '-c:a', 'pcm_s24le', norm]);

const frames = path.join(OUT, 'frames', '%05d.png');
const common = ['-framerate', '60', '-i', frames, '-i', norm, '-map', '0:v', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'slow', '-tune', 'animation', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
  '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart'];
const cm = 'out_color_matrix=bt709:out_range=tv';
ff(['-v', 'error', ...common.slice(0, 4), ...common.slice(4), '-vf', `scale=1920:1080:flags=lanczos:${cm}`, '-crf', '14', path.join(DIST, 'promo_1080p60.mp4')]);
ff(['-v', 'error', ...common, '-vf', `scale=3840:2160:flags=lanczos:${cm}`, '-crf', '16', '-level:v', '5.2', path.join(DIST, 'promo_2160p60.mp4')]);
for (const f of ['promo_1080p60.mp4', 'promo_2160p60.mp4']) {
  const size = fs.statSync(path.join(DIST, f)).size;
  console.log(`dist/${f}  ${(size / 1e6).toFixed(1)} MB`);
}
