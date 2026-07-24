import * as THREE from "three";
import { smoothstep } from "./utils.js";
import { buildGeodesicTopology } from "./geodesic.js";
import { createPaletteCycler, BLACK, sampleCyclingColor } from "./palette.js";

const RADIUS = 10;
const GROUP_Z_OFFSET = -2; // push the (now bigger) sphere back so it doesn't engulf the camera
const DETAIL = 5;
const NODE_SIZE = 0.22;
const PULSE_COUNT = 60;
const PULSE_SPEED_MIN = 1.6; // fraction of an edge crossed per second
const PULSE_SPEED_MAX = 2.0;
const PULSE_SEGMENTS = 8; // sub-segments per pulse's own tiny trail geometry
const PULSE_GLOW_WIDTH = 0.26; // width (in edge-parametric units) of the glow peak
const PULSE_RANGE_PAD = 0.35; // travel this far past each end before entering/leaving, so the peak fades in/out instead of snapping
const PULSE_BRIGHTNESS = 2.8;
const ROTATE_SPEED_Y = 0.05;
const ROTATE_SPEED_X = 0.02;
const FLICKER_MIN_INTERVAL = 3;
const FLICKER_MAX_INTERVAL = 45;
const FLICKER_DURATION = 0.15;

const IGNITE_HOLD = 0.3; // pause before the light-up wave starts
const IGNITE_SWEEP = 1.4; // time for the wave to travel from top to bottom
const IGNITE_FADE = 0.5; // black -> lit duration, per node/edge
const IGNITE_JITTER = 0.15; // tiny per-node randomness on top of the wave
const EDGE_PHASE_PAUSE = -1.0; // gap between "all nodes lit" and the edges' own wave starting (negative = starts slightly before that point)
const EDGE_SWEEP = 2.4; // time for the edges' own wave to cross the structure
const EDGE_TRAVEL_DURATION = 0.2; // time for the light to travel end-to-end along one edge
const PULSE_SPAWN_STAGGER = 3.2; // spread of pulse spawn times after the edges finish

export function createGeoSphereField() {
  const { vertices, edges } = buildGeodesicTopology(RADIUS, DETAIL);
  const group = new THREE.Group();
  group.position.z = GROUP_Z_OFFSET;
  const paletteCycler = createPaletteCycler();
  const tmpColor = new THREE.Color();

  const minY = Math.min(...vertices.map((v) => v.y));
  const maxY = Math.max(...vertices.map((v) => v.y));
  const yRange = maxY - minY || 1;

  // ---- Nodes: one small cube per vertex ----
  const nodeGeometry = new THREE.BoxGeometry(NODE_SIZE, NODE_SIZE, NODE_SIZE);
  const nodeMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const nodeMesh = new THREE.InstancedMesh(
    nodeGeometry,
    nodeMaterial,
    vertices.length
  );
  const dummy = new THREE.Object3D();
  const nodeState = vertices.map((position) => {
    const distRatio = (maxY - position.y) / yRange;
    return {
      distRatio,
      igniteStart:
        IGNITE_HOLD +
        distRatio * IGNITE_SWEEP +
        (Math.random() - 0.5) * IGNITE_JITTER,
      colorPhase: Math.random() * paletteCycler.palette.length,
      colorSpeed: 0.04 + Math.random() * 0.08,
      rotationSpeed: new THREE.Vector3(
        (Math.random() - 0.5) * 0.4,
        (Math.random() - 0.5) * 0.4,
        (Math.random() - 0.5) * 0.4
      ),
      nextFlickerAt:
        FLICKER_MIN_INTERVAL +
        Math.random() * (FLICKER_MAX_INTERVAL - FLICKER_MIN_INTERVAL),
      flickerUntil: -Infinity,
    };
  });
  vertices.forEach((position, i) => {
    dummy.position.copy(position);
    dummy.updateMatrix();
    nodeMesh.setMatrixAt(i, dummy.matrix);
  });
  nodeMesh.instanceMatrix.needsUpdate = true;
  group.add(nodeMesh);

  // ---- Edges: a single glowing wireframe, non-indexed line segments ----
  // Edges only start their own wave once every node has fully finished
  // lighting up (a fully separate phase, not overlapping the node wave).
  // Within that second wave, each edge's two vertex-color slots still turn
  // on at *different* times — the higher of its two nodes lights first, the
  // lower one EDGE_TRAVEL_DURATION later — so the GPU's own linear
  // interpolation between vertex colors makes the brightness visibly travel
  // down each edge for free.
  const allNodesLitAt =
    Math.max(...nodeState.map((s) => s.igniteStart)) + IGNITE_FADE;
  const edgePhaseStart = allNodesLitAt + EDGE_PHASE_PAUSE;

  const edgePositions = new Float32Array(edges.length * 2 * 3);
  const edgeColors = new Float32Array(edges.length * 2 * 3);
  const edgeSlotIgniteStart = new Float32Array(edges.length * 2);
  edges.forEach(([a, b], i) => {
    edgePositions.set(vertices[a].toArray(), i * 6);
    edgePositions.set(vertices[b].toArray(), i * 6 + 3);

    const edgeDistRatio = (nodeState[a].distRatio + nodeState[b].distRatio) / 2;
    const aIsSource = nodeState[a].distRatio <= nodeState[b].distRatio;
    const sourceStart = edgePhaseStart + edgeDistRatio * EDGE_SWEEP;
    const destStart = sourceStart + EDGE_TRAVEL_DURATION;
    edgeSlotIgniteStart[i * 2] = aIsSource ? sourceStart : destStart;
    edgeSlotIgniteStart[i * 2 + 1] = aIsSource ? destStart : sourceStart;
  });
  const fullyLitAt = Math.max(...edgeSlotIgniteStart) + IGNITE_FADE;

  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(edgePositions, 3)
  );
  edgeGeometry.setAttribute(
    "color",
    new THREE.BufferAttribute(edgeColors, 3)
  );
  const edgeMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.1,
  });
  const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  group.add(edgeLines);

  // ---- Pulses: a moving brightness peak rendered purely via vertex colors
  // on a small dedicated line buffer per pulse — no mesh markers. Each
  // pulse gets its own tiny subdivided trail (PULSE_SEGMENTS sub-segments)
  // that repositions onto whichever edge it currently occupies; a
  // Gaussian-ish falloff around its current parametric position `t` makes
  // the glow travel smoothly without needing to subdivide the (huge) main
  // wireframe itself.
  const pulsePositions = new Float32Array(
    PULSE_COUNT * PULSE_SEGMENTS * 2 * 3
  );
  const pulseColors = new Float32Array(PULSE_COUNT * PULSE_SEGMENTS * 2 * 3);
  const pulseGeometry = new THREE.BufferGeometry();
  pulseGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(pulsePositions, 3)
  );
  pulseGeometry.setAttribute(
    "color",
    new THREE.BufferAttribute(pulseColors, 3)
  );
  const pulseMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 1,
  });
  const pulseLines = new THREE.LineSegments(pulseGeometry, pulseMaterial);
  group.add(pulseLines);

  const pulseState = Array.from({ length: PULSE_COUNT }, () => ({
    edgeIndex: Math.floor(Math.random() * edges.length),
    t: -PULSE_RANGE_PAD,
    spawnAt: fullyLitAt + Math.random() * PULSE_SPAWN_STAGGER,
    speed:
      PULSE_SPEED_MIN + Math.random() * (PULSE_SPEED_MAX - PULSE_SPEED_MIN),
    colorPhase: Math.random() * paletteCycler.palette.length,
  }));

  let lastElapsed = 0;

  function update(elapsed) {
    const dt = Math.max(elapsed - lastElapsed, 0);
    lastElapsed = elapsed;

    const inPaletteGlitch = paletteCycler.update(elapsed);
    const palette = paletteCycler.palette;

    group.rotation.y = elapsed * ROTATE_SPEED_Y;
    group.rotation.x = Math.sin(elapsed * ROTATE_SPEED_X) * 0.3;

    // nodes
    for (let i = 0; i < vertices.length; i++) {
      const state = nodeState[i];

      dummy.position.copy(vertices[i]);
      dummy.rotation.set(
        elapsed * state.rotationSpeed.x,
        elapsed * state.rotationSpeed.y,
        elapsed * state.rotationSpeed.z
      );
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      nodeMesh.setMatrixAt(i, dummy.matrix);

      const igniteT = Math.min(
        Math.max((elapsed - state.igniteStart) / IGNITE_FADE, 0),
        1
      );
      const igniteProgress = smoothstep(igniteT);

      if (igniteProgress >= 1 && elapsed >= state.nextFlickerAt) {
        state.colorPhase = Math.random() * palette.length;
        state.flickerUntil = elapsed + FLICKER_DURATION;
        state.nextFlickerAt =
          elapsed +
          FLICKER_MIN_INTERVAL +
          Math.random() * (FLICKER_MAX_INTERVAL - FLICKER_MIN_INTERVAL);
      }

      const t = elapsed * state.colorSpeed + state.colorPhase;
      sampleCyclingColor(palette, t, tmpColor);
      tmpColor.lerpColors(BLACK, tmpColor, igniteProgress);

      if (elapsed < state.flickerUntil) {
        tmpColor.multiplyScalar(Math.random() < 0.5 ? 0.15 : 1.8);
      }
      if (inPaletteGlitch) {
        tmpColor.multiplyScalar(Math.random() < 0.5 ? 0.1 : 2.2);
      }

      nodeMesh.setColorAt(i, tmpColor);
    }
    nodeMesh.instanceMatrix.needsUpdate = true;
    nodeMesh.instanceColor.needsUpdate = true;

    // edges — shared, slowly cycling wire hue, revealed per-edge via the wave
    sampleCyclingColor(palette, elapsed * 0.05, tmpColor);
    if (inPaletteGlitch) {
      tmpColor.multiplyScalar(Math.random() < 0.5 ? 0.1 : 2.2);
    }
    const colorAttr = edgeGeometry.attributes.color;
    for (let i = 0; i < edges.length; i++) {
      for (let slot = 0; slot < 2; slot++) {
        const idx = i * 2 + slot;
        const igniteT = Math.min(
          Math.max((elapsed - edgeSlotIgniteStart[idx]) / IGNITE_FADE, 0),
          1
        );
        const igniteProgress = smoothstep(igniteT);
        colorAttr.setXYZ(
          idx,
          tmpColor.r * igniteProgress,
          tmpColor.g * igniteProgress,
          tmpColor.b * igniteProgress
        );
      }
    }
    colorAttr.needsUpdate = true;

    // pulses — each one spawns individually, staggered after the edges
    // finish, then its tiny trail geometry repositions onto whichever edge
    // it currently occupies with a moving brightness peak along it
    const pulsePosAttr = pulseGeometry.attributes.position;
    const pulseColorAttr = pulseGeometry.attributes.color;
    for (let i = 0; i < PULSE_COUNT; i++) {
      const pulse = pulseState[i];
      const spawned = elapsed >= pulse.spawnAt;

      if (spawned) {
        pulse.t += pulse.speed * dt;
        if (pulse.t >= 1 + PULSE_RANGE_PAD) {
          pulse.t = -PULSE_RANGE_PAD;
          pulse.edgeIndex = Math.floor(Math.random() * edges.length);
        }
      }

      const [a, b] = edges[pulse.edgeIndex];

      sampleCyclingColor(palette, elapsed * 0.15 + pulse.colorPhase, tmpColor);
      tmpColor.multiplyScalar(PULSE_BRIGHTNESS);
      if (inPaletteGlitch) {
        tmpColor.multiplyScalar(Math.random() < 0.5 ? 0.1 : 2.2);
      }

      for (let k = 0; k < PULSE_SEGMENTS; k++) {
        const segIndex = i * PULSE_SEGMENTS + k;
        const localT0 = k / PULSE_SEGMENTS;
        const localT1 = (k + 1) / PULSE_SEGMENTS;

        dummy.position.lerpVectors(vertices[a], vertices[b], localT0);
        pulsePosAttr.setXYZ(
          segIndex * 2,
          dummy.position.x,
          dummy.position.y,
          dummy.position.z
        );
        dummy.position.lerpVectors(vertices[a], vertices[b], localT1);
        pulsePosAttr.setXYZ(
          segIndex * 2 + 1,
          dummy.position.x,
          dummy.position.y,
          dummy.position.z
        );

        const intensity0 = spawned
          ? Math.exp(-(((localT0 - pulse.t) / PULSE_GLOW_WIDTH) ** 2))
          : 0;
        const intensity1 = spawned
          ? Math.exp(-(((localT1 - pulse.t) / PULSE_GLOW_WIDTH) ** 2))
          : 0;

        pulseColorAttr.setXYZ(
          segIndex * 2,
          tmpColor.r * intensity0,
          tmpColor.g * intensity0,
          tmpColor.b * intensity0
        );
        pulseColorAttr.setXYZ(
          segIndex * 2 + 1,
          tmpColor.r * intensity1,
          tmpColor.g * intensity1,
          tmpColor.b * intensity1
        );
      }
    }
    pulsePosAttr.needsUpdate = true;
    pulseColorAttr.needsUpdate = true;

    return inPaletteGlitch;
  }

  return { mesh: group, update };
}
