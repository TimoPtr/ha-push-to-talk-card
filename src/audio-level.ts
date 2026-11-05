// Adapted from the Home Assistant frontend (Apache-2.0),
// src/common/audio/watch-audio-level.ts.

/**
 * The next level of the meter, between 0 and 1, from one frame of samples.
 *
 * Root mean square is the loudness; in decibels it matches what we hear.
 * Silence (-60 dB) maps to 0 and loud speech (-10 dB) to 1. The level rises
 * immediately but falls slowly (about a second), so it fades out.
 */
export function nextLevel(samples: Float32Array, previous: number): number {
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  const decibels = 20 * Math.log10(Math.sqrt(sum / samples.length));
  const current = Math.min(1, Math.max(0, (decibels + 60) / 50));
  return Math.max(current, previous * 0.95);
}

/**
 * Measures the volume of an audio track with the Web Audio API.
 *
 * Calls `onLevel` with a level between 0 and 1, rounded to steps of 0.05 and
 * only when it changed, so silence does not cause work every frame.
 * Returns a function that stops measuring and releases the audio context.
 */
export function watchAudioLevel(
  track: MediaStreamTrack,
  onLevel: (level: number) => void,
): () => void {
  if (typeof AudioContext === "undefined") {
    return () => undefined;
  }
  const context = new AudioContext();
  // Browsers can start an audio context suspended. Resume without waiting:
  // until it runs the level is 0.
  context.resume().catch(() => undefined);
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(new MediaStream([track])).connect(analyser);

  const samples = new Float32Array(analyser.fftSize);
  let level = 0;
  let reported = -1;
  let frame = 0;

  const tick = () => {
    analyser.getFloatTimeDomainData(samples);
    level = nextLevel(samples, level);
    const rounded = Math.round(level * 20) / 20;
    if (rounded !== reported) {
      reported = rounded;
      onLevel(rounded);
    }
    frame = requestAnimationFrame(tick);
  };
  tick();

  return () => {
    cancelAnimationFrame(frame);
    context.close().catch(() => undefined);
  };
}
