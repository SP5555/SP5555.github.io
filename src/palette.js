import * as THREE from "three";

export const PALETTE_SETS = [
  [0x4fd8ff, 0x5b7fff, 0x7c5cff, 0x9b5cf0],
  [0xff4d4d, 0xff7b42, 0xffa94d],
  [0xff4fd8, 0xd84fff, 0x4fe8ff],
  [0x8ba888, 0xd9c17c, 0xd98e6b, 0xa8785a],
];

export const BLACK = new THREE.Color(0x000000);

function toColorArray(hexes) {
  return hexes.map((c) => new THREE.Color(c));
}

// Independent per-instance cycler: picks a random palette, blends smoothly
// between its colors over time, and every `swapInterval` seconds jumps to a
// different palette with a brief chaotic glitch-strobe at the transition.
export function createPaletteCycler({
  swapInterval = 30,
  glitchDuration = 0.16,
} = {}) {
  let paletteIndex = Math.floor(Math.random() * PALETTE_SETS.length);
  let palette = toColorArray(PALETTE_SETS[paletteIndex]);
  let nextSwapAt = swapInterval;
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
      nextSwapAt = elapsed + swapInterval;
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
