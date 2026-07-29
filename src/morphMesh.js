import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { smoothstep } from "./utils.js";
import { createPaletteCycler, sampleCyclingColor, BLACK } from "./palette.js";

// ---- A morphing, faceted gem, built from two nested layers of the same
// icosphere topology, sharing one noise field so they bulge in sync:
//   - Outer shell: FACET_FILL < 1 leaves gaps between facets, and it only
//     carries a dim, glint-driven self-lit look — no patch glow of its
//     own.
//   - Inner core: a smaller radius, always fully seamless, sitting
//     completely black except where a Gaussian glow patch (spawned on a
//     random facet, spreading outward by graph distance across the
//     mesh's real triangle adjacency) lights it up.
// The inner glow is only ever visible through the outer shell's gaps —
// light "leaking through cracks" rather than the surface glowing
// directly. Both layers reuse the exact same per-vertex bulge value, so
// there's no seam mismatch or desync between them. ----

const RADIUS = 10;
const DETAIL = 16; // icosphere subdivision level — higher = more facets, more expensive
const GROUP_Z_OFFSET = -8;

const FACET_FILL = 0.96; // outer shell: 1.0 = seamless, <1 = gaps the inner core glows through

// inner core's radius is always this fraction of the outer shell's radius
// *at that same vertex, that same frame* — since it's a straight multiple
// of an always-positive value, it can never exceed the outer shell,
// no matter how the other constants get tuned
const INNER_RADIUS_RATIO = 0.998;

// spatial frequency of the morphing noise wanders between these bounds
// over time instead of sitting at one fixed value — see createValueWanderer
const NOISE_FREQ_MIN = 0.2;
const NOISE_FREQ_MAX = 10;
const NOISE_FREQ_INTERVAL_MIN = 4; // seconds to hold near a target before picking a new one
const NOISE_FREQ_INTERVAL_MAX = 6;
const NOISE_FREQ_TRANSITION = 4; // seconds to ease from one target to the next

const TIME_SPEED = 0.06; // how fast the surface morphs over time
const DISPLACEMENT_AMPLITUDE = 0.3; // how far vertices bulge in/out

const GLOW_FLOOR = 0.0; // inner core's rest brightness — 0 keeps it genuinely black between patches
const GLOW_MAX = 1.6; // hard cap on the inner core's total glow, in case several patches overlap

// ---- Global breathe: same idea as the cube scene's breathing wave — on a
// random interval, the whole inner core flashes together once, adding onto
// whatever the patches are doing but still capped by GLOW_MAX overall ----
const BREATHE_INTERVAL_MIN = 4; // seconds between global flashes
const BREATHE_INTERVAL_MAX = 10;
const BREATHE_FIRST_DELAY = 2; // don't start until the boot ignite has settled
const BREATHE_DURATION = 2.6; // total time from flash start to fully faded out
const BREATHE_ATTACK = 0.2; // seconds to ramp up to peak brightness
const BREATHE_BRIGHTNESS = 0.6; // extra glow at the flash's peak
const GLOW_FACET_SHRINK = 0.32; // how much a facet's own FACET_FILL shrinks (gap widens) at max local glow — reacts to patches and the global breathe alike, since both feed the same glow value

// ---- Glow patches: independent Gaussian "blooms" of light, each centered
// on a random facet and spreading over its neighbors by graph distance
// (hops across the mesh's actual triangle adjacency, built once at
// startup — not per frame). Each patch fades in, holds, fades out, then
// after a random wait respawns at a new random facet. Glow is driven
// entirely by these — not by the morph displacement — so shape and
// brightness read as two decoupled things. ----
const PATCH_COUNT = 60; // how many patches are alive/waiting at once
const PATCH_SIZE_MIN = 1; // gaussian sigma, in hop-distance (~triangles) across the surface
const PATCH_SIZE_MAX = 4;
const PATCH_DURATION_MIN = 2.0; // seconds a patch stays alive (light-up + fade out)
const PATCH_DURATION_MAX = 6.0;
const PATCH_ATTACK_MIN = 0.1; // seconds to ramp up to peak brightness at spawn
const PATCH_ATTACK_MAX = 0.2;
const PATCH_WAIT_MIN = 0.0; // gap after a patch dies before that slot spawns a new one
const PATCH_WAIT_MAX = 1.0;
const PATCH_BRIGHTNESS = 1.0; // peak brightness at a patch's center
const PATCH_SIGMA_CUTOFF = 2.8; // truncate the gaussian tail past this many sigmas (perf, not visual)

const GLINT_SHARPNESS = 6; // higher = narrower, snappier glint highlights
const GLINT_MIN = 0.01; // outer shell's brightness at worst-angle facets (baseline self-lit look)
const GLINT_MAX = 0.04; // outer shell's brightness at perfectly-aligned facets
const LIGHT_DIR = new THREE.Vector3(0.4, 0.6, 1).normalize();

const COLOR_SPEED_MIN = 0.01;
const COLOR_SPEED_MAX = 0.04;

const ROTATE_SPEED_Y = 0.02;
const ROTATE_SPEED_X = 0.01;
const ROTATE_WOBBLE = 0.18;

// ---- Boot ignite: facets light up in a wave from top to bottom, same
// timing pattern as the network scene's node ignite ----
const IGNITE_HOLD = 0.0; // pause before the light-up wave starts
const IGNITE_SWEEP = 3.0; // time for the wave to travel from top to bottom
const IGNITE_FADE = 1.0; // black -> lit duration, per facet
const IGNITE_JITTER = 0.6; // tiny per-facet randomness on top of the wave

function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123;
  return s - Math.floor(s);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function noise3D(x, y, z) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const x00 = lerp(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), ux);
  const x10 = lerp(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), ux);
  const x01 = lerp(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), ux);
  const x11 = lerp(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), ux);
  const y0 = lerp(x00, x10, uy);
  const y1 = lerp(x01, x11, uy);
  return lerp(y0, y1, uz);
}

function fbm3D(x, y, z) {
  let value = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < 4; i++) {
    value += amp * noise3D(x * freq, y * freq, z * freq);
    freq *= 2;
    amp *= 0.5;
  }
  return value;
}

// Builds each face's list of neighboring faces (sharing an edge) once, up
// front — every edge belongs to exactly two faces on a closed mesh like
// this icosphere, so a single pass grouping faces by their edges is
// enough. This never needs to run again after construction.
function buildFaceAdjacency(faceIndices, faceCount) {
  const edgeFaces = new Map();
  const adjacency = Array.from({ length: faceCount }, () => []);

  function addEdge(v0, v1, faceIdx) {
    const key = v0 < v1 ? `${v0}_${v1}` : `${v1}_${v0}`;
    const existing = edgeFaces.get(key);
    if (existing) {
      existing.push(faceIdx);
      if (existing.length === 2) {
        adjacency[existing[0]].push(existing[1]);
        adjacency[existing[1]].push(existing[0]);
      }
    } else {
      edgeFaces.set(key, [faceIdx]);
    }
  }

  for (let f = 0; f < faceCount; f++) {
    const i0 = faceIndices[f * 3];
    const i1 = faceIndices[f * 3 + 1];
    const i2 = faceIndices[f * 3 + 2];
    addEdge(i0, i1, f);
    addEdge(i1, i2, f);
    addEdge(i2, i0, f);
  }

  return adjacency;
}

// Breadth-first search out from a starting face, across the adjacency
// graph, stopping once the hop distance passes maxHops. Only runs once
// per patch spawn (not per frame), and only ever touches the facets
// actually within reach — not the whole mesh.
function bfsWithinHops(adjacency, startFace, maxHops) {
  const hopOf = new Map();
  hopOf.set(startFace, 0);
  const reached = [[startFace, 0]];
  let frontier = [startFace];
  let hop = 0;

  while (hop < maxHops && frontier.length > 0) {
    hop++;
    const nextFrontier = [];
    for (const f of frontier) {
      for (const n of adjacency[f]) {
        if (!hopOf.has(n)) {
          hopOf.set(n, hop);
          nextFrontier.push(n);
          reached.push([n, hop]);
        }
      }
    }
    frontier = nextFrontier;
  }

  return reached;
}

// A scalar that eases toward a fresh random target within [min, max] every
// interval seconds (randomized between intervalMin/Max), instead of
// sitting at one fixed value — same "random target + smooth ease" idea as
// the palette cycler, just for a single number. With logScale, targets are
// sampled uniformly in log-space instead of linear-space, so every
// "doubling" within [min, max] is equally likely to be picked — a better
// fit for values (like a spatial frequency) whose *effect* is
// multiplicative rather than additive.
function createValueWanderer({
  min,
  max,
  intervalMin,
  intervalMax,
  transitionDuration,
  logScale = false,
}) {
  const logMin = Math.log(min);
  const logMax = Math.log(max);
  function sampleTarget() {
    if (logScale) return Math.exp(logMin + Math.random() * (logMax - logMin));
    return min + Math.random() * (max - min);
  }

  let fromValue = sampleTarget();
  let toValue = sampleTarget();
  let transitionStart = 0;
  let nextChangeAt =
    intervalMin + Math.random() * (intervalMax - intervalMin);

  function blendT(elapsed) {
    return smoothstep(
      Math.min(
        Math.max((elapsed - transitionStart) / transitionDuration, 0),
        1
      )
    );
  }

  function currentValue(elapsed) {
    return fromValue + (toValue - fromValue) * blendT(elapsed);
  }

  function step(elapsed) {
    if (elapsed >= nextChangeAt) {
      // start the new transition from wherever we actually are right now,
      // not the old target — otherwise a retrigger before the previous
      // transition finished (e.g. intervalMin < transitionDuration) would
      // snap the value instead of continuing smoothly
      fromValue = currentValue(elapsed);
      toValue = sampleTarget();
      transitionStart = elapsed;
      nextChangeAt =
        elapsed + intervalMin + Math.random() * (intervalMax - intervalMin);
    }
  }

  // exposes the raw from/to/blend state instead of a single interpolated
  // number — for callers that need to blend something derived from this
  // value (e.g. two full noise evaluations) rather than blending the
  // parameter itself, which can produce erratic in-between results when
  // the parameter's effect is nonlinear (like a spatial frequency)
  function getBlendState(elapsed) {
    step(elapsed);
    return { from: fromValue, to: toValue, blend: blendT(elapsed) };
  }

  return { getBlendState };
}

export function createMorphMesh() {
  // IcosahedronGeometry builds non-indexed geometry (duplicate vertices at
  // UV seams) — strip the seam-varying attributes and weld matching
  // positions so shared edges resolve to one actual vertex index. Without
  // this, adjacent faces at a seam wouldn't agree on displacement.
  let baseGeometry = new THREE.IcosahedronGeometry(RADIUS, DETAIL);
  baseGeometry.deleteAttribute("uv");
  baseGeometry.deleteAttribute("normal");
  baseGeometry = mergeVertices(baseGeometry);

  const basePosAttr = baseGeometry.getAttribute("position");
  const indexAttr = baseGeometry.getIndex();
  const vertexCount = basePosAttr.count;
  const faceCount = indexAttr.count / 3;
  const faceIndices = indexAttr.array;

  // rest direction (unit vector) per unique vertex — displacement always
  // moves along this, so bulging in/out never distorts the base topology
  const restDirs = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    const x = basePosAttr.getX(i);
    const y = basePosAttr.getY(i);
    const z = basePosAttr.getZ(i);
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    restDirs[i * 3] = x / len;
    restDirs[i * 3 + 1] = y / len;
    restDirs[i * 3 + 2] = z / len;
  }

  // scratch buffers, recomputed once per unique vertex each frame (not
  // once per face-corner) — that's what keeps shared edges in sync.
  // Both layers share the same "signed" noise value per vertex (just
  // applied at two different radii), so they bulge in perfect sync.
  const dispSigned = new Float32Array(vertexCount);
  const dispX = new Float32Array(vertexCount);
  const dispY = new Float32Array(vertexCount);
  const dispZ = new Float32Array(vertexCount);
  const innerX = new Float32Array(vertexCount);
  const innerY = new Float32Array(vertexCount);
  const innerZ = new Float32Array(vertexCount);

  const positions = new Float32Array(faceCount * 9);
  const colors = new Float32Array(faceCount * 9);
  const outerGeometry = new THREE.BufferGeometry();
  outerGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  outerGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const posAttr = outerGeometry.getAttribute("position");
  const colorAttr = outerGeometry.getAttribute("color");

  const outerMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  const outerMesh = new THREE.Mesh(outerGeometry, outerMaterial);

  const innerPositions = new Float32Array(faceCount * 9);
  const innerColors = new Float32Array(faceCount * 9);
  const innerGeometry = new THREE.BufferGeometry();
  innerGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(innerPositions, 3)
  );
  innerGeometry.setAttribute("color", new THREE.BufferAttribute(innerColors, 3));
  const innerPosAttr = innerGeometry.getAttribute("position");
  const innerColorAttr = innerGeometry.getAttribute("color");

  const innerMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  const innerMesh = new THREE.Mesh(innerGeometry, innerMaterial);

  const group = new THREE.Group();
  group.add(outerMesh);
  group.add(innerMesh);
  group.position.z = GROUP_Z_OFFSET;

  // top-to-bottom ignite wave, timed off each facet's *rest* vertical
  // position (stable even though the surface keeps morphing afterward)
  let maxY = -Infinity;
  let minY = Infinity;
  for (let i = 0; i < vertexCount; i++) {
    const y = restDirs[i * 3 + 1];
    if (y > maxY) maxY = y;
    if (y < minY) minY = y;
  }
  const yRange = maxY - minY || 1;

  const faceMeta = [];
  for (let f = 0; f < faceCount; f++) {
    const i0 = faceIndices[f * 3];
    const i1 = faceIndices[f * 3 + 1];
    const i2 = faceIndices[f * 3 + 2];
    const avgY =
      (restDirs[i0 * 3 + 1] + restDirs[i1 * 3 + 1] + restDirs[i2 * 3 + 1]) / 3;
    const distRatio = (maxY - avgY) / yRange;

    faceMeta.push({
      colorPhase: Math.random() * 5,
      colorSpeed:
        COLOR_SPEED_MIN + Math.random() * (COLOR_SPEED_MAX - COLOR_SPEED_MIN),
      igniteStart:
        IGNITE_HOLD +
        distRatio * IGNITE_SWEEP +
        (Math.random() - 0.5) * IGNITE_JITTER,
    });
  }

  const adjacency = buildFaceAdjacency(faceIndices, faceCount);

  // summed Gaussian contribution from every currently-alive patch, per
  // facet — rebuilt fresh each frame from only the (few) active patches'
  // (already-computed) reached lists, never a per-facet graph walk
  const glowAccum = new Float32Array(faceCount);

  const patches = [];
  for (let p = 0; p < PATCH_COUNT; p++) {
    patches.push({
      alive: false,
      reached: [],
      spawnTime: 0,
      duration: 1,
      nextEventAt:
        Math.random() * (PATCH_WAIT_MIN + PATCH_WAIT_MAX), // stagger initial spawns
    });
  }

  function spawnPatch(patch, elapsed) {
    const centerFace = Math.floor(Math.random() * faceCount);
    const sigma =
      PATCH_SIZE_MIN + Math.random() * (PATCH_SIZE_MAX - PATCH_SIZE_MIN);
    const maxHops = Math.ceil(sigma * PATCH_SIGMA_CUTOFF);

    patch.alive = true;
    // precompute each reached facet's Gaussian falloff once, here — it only
    // depends on hop-distance and sigma, both fixed for this patch's whole
    // lifetime, so recomputing Math.exp() every frame in the render loop
    // (for every reached facet, of every active patch) would be pure waste
    const twoSigmaSq = 2 * sigma * sigma;
    patch.reached = bfsWithinHops(adjacency, centerFace, maxHops).map(
      ([face, hop]) => [face, Math.exp(-(hop * hop) / twoSigmaSq)]
    );
    patch.spawnTime = elapsed;
    patch.duration =
      PATCH_DURATION_MIN +
      Math.random() * (PATCH_DURATION_MAX - PATCH_DURATION_MIN);
    patch.attack = Math.min(
      PATCH_ATTACK_MIN + Math.random() * (PATCH_ATTACK_MAX - PATCH_ATTACK_MIN),
      patch.duration * 0.9
    );
    patch.nextEventAt = elapsed + patch.duration;
  }

  const paletteCycler = createPaletteCycler();
  const noiseFreqWanderer = createValueWanderer({
    min: NOISE_FREQ_MIN,
    max: NOISE_FREQ_MAX,
    intervalMin: NOISE_FREQ_INTERVAL_MIN,
    intervalMax: NOISE_FREQ_INTERVAL_MAX,
    transitionDuration: NOISE_FREQ_TRANSITION,
    logScale: true,
  });
  const tmpColor = new THREE.Color();
  const lightDirLocal = new THREE.Vector3();
  const groupQuatInv = new THREE.Quaternion();

  let nextBreatheAt =
    BREATHE_FIRST_DELAY +
    Math.random() * (BREATHE_INTERVAL_MAX - BREATHE_INTERVAL_MIN);
  let breatheStartTime = null;

  function update(elapsed) {
    // set the group's rotation for this frame first, so its quaternion is
    // current before we use it below to keep the glint pointed at a
    // direction fixed in world space (not spinning along with the mesh)
    group.rotation.y = elapsed * ROTATE_SPEED_Y;
    group.rotation.x = Math.sin(elapsed * ROTATE_SPEED_X) * ROTATE_WOBBLE;
    groupQuatInv.copy(group.quaternion).invert();
    lightDirLocal.copy(LIGHT_DIR).applyQuaternion(groupQuatInv);

    const inPaletteGlitch = paletteCycler.update(elapsed);
    const palette = paletteCycler.palette;

    if (elapsed >= nextBreatheAt) {
      breatheStartTime = elapsed;
      nextBreatheAt =
        elapsed +
        BREATHE_INTERVAL_MIN +
        Math.random() * (BREATHE_INTERVAL_MAX - BREATHE_INTERVAL_MIN);
    }
    let breatheEnvelope = 0;
    if (breatheStartTime !== null) {
      const sinceBreathe = elapsed - breatheStartTime;
      if (sinceBreathe < BREATHE_ATTACK) {
        breatheEnvelope = smoothstep(sinceBreathe / BREATHE_ATTACK);
      } else {
        const decayT = Math.min(
          Math.max(
            (sinceBreathe - BREATHE_ATTACK) / (BREATHE_DURATION - BREATHE_ATTACK),
            0
          ),
          1
        );
        breatheEnvelope = 1 - smoothstep(decayT);
      }
    }
    const breatheGlow = breatheEnvelope * BREATHE_BRIGHTNESS;

    glowAccum.fill(0);
    for (let p = 0; p < PATCH_COUNT; p++) {
      const patch = patches[p];

      if (elapsed >= patch.nextEventAt) {
        if (patch.alive) {
          patch.alive = false;
          patch.nextEventAt =
            elapsed +
            PATCH_WAIT_MIN +
            Math.random() * (PATCH_WAIT_MAX - PATCH_WAIT_MIN);
        } else {
          spawnPatch(patch, elapsed);
        }
      }

      if (!patch.alive) continue;

      // ramps up to peak over patch.attack, then eases out over the
      // remainder of the patch's lifetime
      const sinceSpawn = elapsed - patch.spawnTime;
      let envelope;
      if (sinceSpawn < patch.attack) {
        envelope = smoothstep(sinceSpawn / patch.attack) * PATCH_BRIGHTNESS;
      } else {
        const decayT = Math.min(
          Math.max(
            (sinceSpawn - patch.attack) / (patch.duration - patch.attack),
            0
          ),
          1
        );
        envelope = (1 - smoothstep(decayT)) * PATCH_BRIGHTNESS;
      }

      for (const [face, falloff] of patch.reached) {
        glowAccum[face] += envelope * falloff;
      }
    }

    const { from: freqFrom, to: freqTo, blend: freqBlend } =
      noiseFreqWanderer.getBlendState(elapsed);
    const timeOffset = elapsed * TIME_SPEED;
    for (let i = 0; i < vertexCount; i++) {
      const dx = restDirs[i * 3];
      const dy = restDirs[i * 3 + 1];
      const dz = restDirs[i * 3 + 2];

      let n;
      if (freqBlend >= 1) {
        // settled — only one frequency in play, one evaluation needed
        n = fbm3D(
          dx * freqTo + timeOffset,
          dy * freqTo - timeOffset * 0.7,
          dz * freqTo + timeOffset * 0.5
        );
      } else {
        // mid-transition: blend the two *resulting* surfaces (evaluated
        // at the old and new frequency) rather than the frequency
        // itself — sweeping the frequency continuously would resample
        // the noise field at rapidly-changing intermediate frequencies,
        // producing erratic, uncorrelated bumps instead of a clean
        // crossfade between two stable shapes
        const nFrom = fbm3D(
          dx * freqFrom + timeOffset,
          dy * freqFrom - timeOffset * 0.7,
          dz * freqFrom + timeOffset * 0.5
        );
        const nTo = fbm3D(
          dx * freqTo + timeOffset,
          dy * freqTo - timeOffset * 0.7,
          dz * freqTo + timeOffset * 0.5
        );
        n = nFrom + (nTo - nFrom) * freqBlend;
      }

      const signed = n * 2 - 1;
      dispSigned[i] = signed;
      const r = RADIUS + signed * DISPLACEMENT_AMPLITUDE;
      dispX[i] = dx * r;
      dispY[i] = dy * r;
      dispZ[i] = dz * r;

      const rInner = r * INNER_RADIUS_RATIO;
      innerX[i] = dx * rInner;
      innerY[i] = dy * rInner;
      innerZ[i] = dz * rInner;
    }

    for (let f = 0; f < faceCount; f++) {
      const i0 = faceIndices[f * 3];
      const i1 = faceIndices[f * 3 + 1];
      const i2 = faceIndices[f * 3 + 2];

      const x0 = dispX[i0], y0 = dispY[i0], z0 = dispZ[i0];
      const x1 = dispX[i1], y1 = dispY[i1], z1 = dispZ[i1];
      const x2 = dispX[i2], y2 = dispY[i2], z2 = dispZ[i2];

      const meta = faceMeta[f];
      const igniteT = Math.min(
        Math.max((elapsed - meta.igniteStart) / IGNITE_FADE, 0),
        1
      );
      const igniteProgress = smoothstep(igniteT);

      // this facet's own inner-core glow (patches + global breathe,
      // already capped) — computed here so it can drive the gap widening
      // below, and reused later for the inner core's own color
      const localGlow = Math.min(glowAccum[f] + breatheGlow, GLOW_MAX - GLOW_FLOOR);
      const glowT = localGlow / (GLOW_MAX - GLOW_FLOOR || 1);

      // scale-pop: each facet starts collapsed to a single point (its own
      // centroid) and grows to its full size as it ignites, reusing the
      // same centroid-shrink math FACET_FILL already relies on. Also
      // shrinks in proportion to this facet's own glow — the gap widens
      // right where the light underneath is brightest.
      const dynamicFacetFill = FACET_FILL - glowT * GLOW_FACET_SHRINK;
      const liveFill = dynamicFacetFill * igniteProgress;

      const cx = (x0 + x1 + x2) / 3;
      const cy = (y0 + y1 + y2) / 3;
      const cz = (z0 + z1 + z2) / 3;

      const sx0 = cx + (x0 - cx) * liveFill;
      const sy0 = cy + (y0 - cy) * liveFill;
      const sz0 = cz + (z0 - cz) * liveFill;
      const sx1 = cx + (x1 - cx) * liveFill;
      const sy1 = cy + (y1 - cy) * liveFill;
      const sz1 = cz + (z1 - cz) * liveFill;
      const sx2 = cx + (x2 - cx) * liveFill;
      const sy2 = cy + (y2 - cy) * liveFill;
      const sz2 = cz + (z2 - cz) * liveFill;

      const base = f * 9;
      positions[base] = sx0;
      positions[base + 1] = sy0;
      positions[base + 2] = sz0;
      positions[base + 3] = sx1;
      positions[base + 4] = sy1;
      positions[base + 5] = sz1;
      positions[base + 6] = sx2;
      positions[base + 7] = sy2;
      positions[base + 8] = sz2;

      const ax = sx1 - sx0, ay = sy1 - sy0, az = sz1 - sz0;
      const bx = sx2 - sx0, by = sy2 - sy0, bz = sz2 - sz0;
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= nlen;
      ny /= nlen;
      nz /= nlen;

      const glintDot = Math.abs(
        nx * lightDirLocal.x + ny * lightDirLocal.y + nz * lightDirLocal.z
      );
      const glint = Math.pow(glintDot, GLINT_SHARPNESS);

      // outer shell: dim, glint-driven self-lit look only — no patch glow
      // here, so the only bright light comes from the inner core showing
      // through its gaps
      const outerBrightness = GLINT_MIN + glint * (GLINT_MAX - GLINT_MIN);
      const t = elapsed * meta.colorSpeed + meta.colorPhase;
      sampleCyclingColor(palette, t, tmpColor);
      // lerp toward BLACK (the scene's actual ambient base color) instead
      // of a plain multiply — the shell is fully opaque, so there's no
      // background blending to fall back on; a dim facet should read as
      // "close to ambient," not fade toward pure black regardless of tone
      tmpColor.lerpColors(BLACK, tmpColor, outerBrightness);
      tmpColor.lerpColors(BLACK, tmpColor, igniteProgress);

      if (inPaletteGlitch) {
        tmpColor.multiplyScalar(Math.random() < 0.5 ? 0.1 : 2.2);
      }

      colors[base] = tmpColor.r;
      colors[base + 1] = tmpColor.g;
      colors[base + 2] = tmpColor.b;
      colors[base + 3] = tmpColor.r;
      colors[base + 4] = tmpColor.g;
      colors[base + 5] = tmpColor.b;
      colors[base + 6] = tmpColor.r;
      colors[base + 7] = tmpColor.g;
      colors[base + 8] = tmpColor.b;

      // inner core: always seamless (only the ignite scale-pop shrinks it,
      // never a resting gap), sitting black except where a glow patch
      // lights it up — that light only reads through the outer shell's gaps
      const ix0 = innerX[i0], iy0 = innerY[i0], iz0 = innerZ[i0];
      const ix1 = innerX[i1], iy1 = innerY[i1], iz1 = innerZ[i1];
      const ix2 = innerX[i2], iy2 = innerY[i2], iz2 = innerZ[i2];

      const icx = (ix0 + ix1 + ix2) / 3;
      const icy = (iy0 + iy1 + iy2) / 3;
      const icz = (iz0 + iz1 + iz2) / 3;

      const isx0 = icx + (ix0 - icx) * igniteProgress;
      const isy0 = icy + (iy0 - icy) * igniteProgress;
      const isz0 = icz + (iz0 - icz) * igniteProgress;
      const isx1 = icx + (ix1 - icx) * igniteProgress;
      const isy1 = icy + (iy1 - icy) * igniteProgress;
      const isz1 = icz + (iz1 - icz) * igniteProgress;
      const isx2 = icx + (ix2 - icx) * igniteProgress;
      const isy2 = icy + (iy2 - icy) * igniteProgress;
      const isz2 = icz + (iz2 - icz) * igniteProgress;

      innerPositions[base] = isx0;
      innerPositions[base + 1] = isy0;
      innerPositions[base + 2] = isz0;
      innerPositions[base + 3] = isx1;
      innerPositions[base + 4] = isy1;
      innerPositions[base + 5] = isz1;
      innerPositions[base + 6] = isx2;
      innerPositions[base + 7] = isy2;
      innerPositions[base + 8] = isz2;

      const innerGlow = GLOW_FLOOR + localGlow;
      sampleCyclingColor(palette, t, tmpColor);
      tmpColor.multiplyScalar(innerGlow);
      tmpColor.lerpColors(BLACK, tmpColor, igniteProgress);

      if (inPaletteGlitch) {
        tmpColor.multiplyScalar(Math.random() < 0.5 ? 0.1 : 2.2);
      }

      innerColors[base] = tmpColor.r;
      innerColors[base + 1] = tmpColor.g;
      innerColors[base + 2] = tmpColor.b;
      innerColors[base + 3] = tmpColor.r;
      innerColors[base + 4] = tmpColor.g;
      innerColors[base + 5] = tmpColor.b;
      innerColors[base + 6] = tmpColor.r;
      innerColors[base + 7] = tmpColor.g;
      innerColors[base + 8] = tmpColor.b;
    }

    posAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
    innerPosAttr.needsUpdate = true;
    innerColorAttr.needsUpdate = true;

    return inPaletteGlitch;
  }

  return { mesh: group, update };
}
