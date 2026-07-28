import * as THREE from "three";

export const PALETTE_SETS = [
  [0x4fd8ff, 0x5b7fff, 0x7c5cff, 0x9b5cf0],
  [0xe0201a, 0xffb14d],
  [0xff4fd8, 0x4fe8ff],
  [0x36e0c9, 0xff8a3d],
  [0x19ff3a, 0xe6ff39],
];

export const BLACK = new THREE.Color(0x000000);

function toColorArray(hexes) {
  return hexes.map((c) => new THREE.Color(c));
}

// Independent per-instance cycler: picks a random palette, blends smoothly
// between its colors over time, and every 'swapIntervalMin'-'swapIntervalMax'
// seconds (randomized per swap, not a fixed cadence) jumps to a different
// palette with a brief chaotic glitch-strobe at the transition.
export function createPaletteCycler({
  swapIntervalMin = 2,
  swapIntervalMax = 30,
  glitchDuration = 0.16,
} = {}) {
  let paletteIndex = Math.floor(Math.random() * PALETTE_SETS.length);
  let palette = toColorArray(PALETTE_SETS[paletteIndex]);

  function pickNextInterval() {
    return (
      swapIntervalMin + Math.random() * (swapIntervalMax - swapIntervalMin)
    );
  }

  let nextSwapAt = pickNextInterval();
  let glitchUntil = -Infinity;

  function update(elapsed) {
    if (elapsed >= nextSwapAt) {
      let nextIndex = Math.floor(Math.random() * PALETTE_SETS.length);
      if (PALETTE_SETS.length > 1 && nextIndex === paletteIndex) {
        nextIndex = (nextIndex + 1) % PALETTE_SETS.length;
      }
      paletteIndex = nextIndex;
      palette = toColorArray(PALETTE_SETS[paletteIndex]);
      glitchUntil = elapsed + glitchDuration;
      nextSwapAt = elapsed + pickNextInterval();
    }
    return elapsed < glitchUntil; // true while the transition glitch is active
  }

  return {
    get palette() {
      return palette;
    },
    update,
  };
}

const tmpColorA = new THREE.Color();

// Blends between two adjacent palette colors at a continuous phase `t`
// (colorSpeed * elapsed + colorPhase), writing the result into `out`.
export function sampleCyclingColor(palette, t, out = tmpColorA) {
  const i0 = Math.floor(t) % palette.length;
  const i1 = (i0 + 1) % palette.length;
  const frac = t - Math.floor(t);
  out.lerpColors(palette[i0], palette[i1], frac);
  return out;
}
