import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { smoothstep } from "./utils.js";
import { createPaletteCycler, sampleCyclingColor, BLACK } from "./palette.js";

// ---- A morphing, faceted gem: an icosphere whose vertices bulge in and
// out over time via 3D noise, rendered as individual triangle facets.
// Brightness is fully decoupled from that morph — instead, independent
// Gaussian glow patches spawn on random facets and spread outward by
// graph distance across the mesh's actual triangle topology (real dark
// troughs, bright glowing peaks — the same "give bloom something dark to
// contrast against" lesson learned from the fluid scene), plus a
// light-catching glint as the whole gem slowly rotates. FACET_FILL
// controls whether facets sit flush against each other (seamless) or
// pull apart into a faceted mosaic (gaps) — same displaced vertex data
// either way, so there's no seam mismatch when FACET_FILL is 1.0. ----

const RADIUS = 10;
const DETAIL = 20; // icosphere subdivision level — higher = more facets, more expensive
const GROUP_Z_OFFSET = -8;

const FACET_FILL = 0.96; // 1.0 = seamless surface, <1 = gaps between facets (try ~0.85)

// spatial frequency of the morphing noise wanders between these bounds
// over time instead of sitting at one fixed value — see createValueWanderer
const NOISE_FREQ_MIN = 0.2;
const NOISE_FREQ_MAX = 1.6;
const NOISE_FREQ_INTERVAL_MIN = 4; // seconds to hold near a target before picking a new one
const NOISE_FREQ_INTERVAL_MAX = 10;
const NOISE_FREQ_TRANSITION = 4; // seconds to ease from one target to the next

const TIME_SPEED = 0.12; // how fast the surface morphs over time
const DISPLACEMENT_AMPLITUDE = 1.0; // how far vertices bulge in/out

const GLOW_FLOOR = 0.2; // baseline brightness so the form stays visible between pulse visits
const GLOW_MAX = 1.0; // hard cap on total glow, in case several pulse trails overlap

// ---- Glow patches: independent Gaussian "blooms" of light, each centered
// on a random facet and spreading over its neighbors by graph distance
// (hops across the mesh's actual triangle adjacency, built once at
// startup — not per frame). Each patch fades in, holds, fades out, then
// after a random wait respawns at a new random facet. Glow is driven
// entirely by these — not by the morph displacement — so shape and
// brightness read as two decoupled things. ----
const PATCH_COUNT = 60; // how many patches are alive/waiting at once
const PATCH_SIZE_MIN = 3; // gaussian sigma, in hop-distance (~triangles) across the surface
const PATCH_SIZE_MAX = 6;
const PATCH_DURATION_MIN = 1.0; // seconds a patch stays alive (light-up + fade out)
const PATCH_DURATION_MAX = 6.0;
const PATCH_ATTACK_MIN = 0.1; // seconds to ramp up to peak brightness at spawn
const PATCH_ATTACK_MAX = 0.2;
const PATCH_WAIT_MIN = 1.0; // gap after a patch dies before that slot spawns a new one
const PATCH_WAIT_MAX = 2.0;
const PATCH_BRIGHTNESS = 0.8; // peak brightness at a patch's center
const PATCH_SIGMA_CUTOFF = 2.6; // truncate the gaussian tail past this many sigmas (perf, not visual)

const GLINT_SHARPNESS = 6; // higher = narrower, snappier glint highlights
const GLINT_MIN = 0.25; // baseline light-catching multiplier even off-angle
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
// the palette cycler, just for a single number.
function createValueWanderer({ min, max, intervalMin, intervalMax, transitionDuration }) {
  let fromValue = min + Math.random() * (max - min);
  let toValue = min + Math.random() * (max - min);
  let transitionStart = 0;
  let nextChangeAt =
    intervalMin + Math.random() * (intervalMax - intervalMin);

  function update(elapsed) {
    if (elapsed >= nextChangeAt) {
      fromValue = toValue;
      toValue = min + Math.random() * (max - min);
      transitionStart = elapsed;
      nextChangeAt =
        elapsed + intervalMin + Math.random() * (intervalMax - intervalMin);
    }
    const t = Math.min(
      Math.max((elapsed - transitionStart) / transitionDuration, 0),
      1
    );
    return fromValue + (toValue - fromValue) * smoothstep(t);
  }

  return { update };
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
  // once per face-corner) — that's what keeps shared edges in sync
  const dispSigned = new Float32Array(vertexCount);
  const dispX = new Float32Array(vertexCount);
  const dispY = new Float32Array(vertexCount);
  const dispZ = new Float32Array(vertexCount);

  const positions = new Float32Array(faceCount * 9);
  const colors = new Float32Array(faceCount * 9);
  const renderGeometry = new THREE.BufferGeometry();
  renderGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  renderGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const posAttr = renderGeometry.getAttribute("position");
  const colorAttr = renderGeometry.getAttribute("color");

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(renderGeometry, material);
  mesh.position.z = GROUP_Z_OFFSET;

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
      sigma: 1,
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
    patch.reached = bfsWithinHops(adjacency, centerFace, maxHops);
    patch.sigma = sigma;
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
  });
  const tmpColor = new THREE.Color();

  function update(elapsed) {
    const inPaletteGlitch = paletteCycler.update(elapsed);
    const palette = paletteCycler.palette;

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

      const twoSigmaSq = 2 * patch.sigma * patch.sigma;
      for (const [face, hop] of patch.reached) {
        glowAccum[face] += envelope * Math.exp(-(hop * hop) / twoSigmaSq);
      }
    }

    const noiseFreq = noiseFreqWanderer.update(elapsed);
    const timeOffset = elapsed * TIME_SPEED;
    for (let i = 0; i < vertexCount; i++) {
      const dx = restDirs[i * 3];
      const dy = restDirs[i * 3 + 1];
      const dz = restDirs[i * 3 + 2];
      const n = fbm3D(
        dx * noiseFreq + timeOffset,
        dy * noiseFreq - timeOffset * 0.7,
        dz * noiseFreq + timeOffset * 0.5
      );
      const signed = n * 2 - 1;
      dispSigned[i] = signed;
      const r = RADIUS + signed * DISPLACEMENT_AMPLITUDE;
      dispX[i] = dx * r;
      dispY[i] = dy * r;
      dispZ[i] = dz * r;
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

      // scale-pop: each facet starts collapsed to a single point (its own
      // centroid) and grows to its full size as it ignites, reusing the
      // same centroid-shrink math FACET_FILL already relies on
      const liveFill = FACET_FILL * igniteProgress;

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
        nx * LIGHT_DIR.x + ny * LIGHT_DIR.y + nz * LIGHT_DIR.z
      );
      const glint = Math.pow(glintDot, GLINT_SHARPNESS);

      const glow = GLOW_FLOOR + Math.min(glowAccum[f], GLOW_MAX - GLOW_FLOOR);
      const brightness = glow * (GLINT_MIN + glint * (1 - GLINT_MIN));
      const t = elapsed * meta.colorSpeed + meta.colorPhase;
      sampleCyclingColor(palette, t, tmpColor);
      tmpColor.multiplyScalar(brightness);
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
    }

    posAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;

    mesh.rotation.y = elapsed * ROTATE_SPEED_Y;
    mesh.rotation.x = Math.sin(elapsed * ROTATE_SPEED_X) * ROTATE_WOBBLE;

    return inPaletteGlitch;
  }

  return { mesh, update };
}
