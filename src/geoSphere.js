import * as THREE from "three";
import { smoothstep } from "./utils.js";
import { buildGeodesicTopology } from "./geodesic.js";
import { createPaletteCycler, BLACK, sampleCyclingColor } from "./palette.js";

const RADIUS = 10;
const GROUP_Z_OFFSET = -2; // push the (now bigger) sphere back so it doesn't engulf the camera
const DETAIL = 5;
const NODE_SIZE = 0.18;
const PULSE_COUNT = 40;
const PULSE_SPEED_MIN = 2.0; // fraction of an edge crossed per second
const PULSE_SPEED_MAX = 3.0;
const PULSE_SEGMENTS = 8; // sub-segments per pulse's own tiny trail geometry
const PULSE_GLOW_WIDTH = 1.0; // width (in edge-parametric units) of the glow peak
// travel this far past each end before entering/leaving, so the Gaussian
// tail has decayed to ~1% before crossing the boundary (fades instead of
// snapping) — derived from PULSE_GLOW_WIDTH so it always stays proportional
const PULSE_RANGE_PAD = PULSE_GLOW_WIDTH * 2.2;
const PULSE_BRIGHTNESS = 2.8;
const ROTATE_SPEED_Y = 0.05;
const ROTATE_SPEED_X = 0.02;
const FLICKER_MIN_INTERVAL = 3;
const FLICKER_MAX_INTERVAL = 45;
const FLICKER_DURATION = 0.15;

const IGNITE_HOLD = 0.3; // pause before the light-up wave starts
const IGNITE_SWEEP = 1.4; // time for the wave to travel from top to bottom
const IGNITE_FADE = 0.5; // black -> lit duration, per node
const IGNITE_JITTER = 0.4; // tiny per-node randomness on top of the wave
const EDGE_PHASE_PAUSE = -1.6; // gap between "all nodes lit" and the edges' own wave starting (negative = starts slightly before that point)
const EDGE_SWEEP = 2.4; // time for the edges' own wave to cross the structure
const EDGE_TRAVEL_DURATION = 0.4; // time for the light to travel end-to-end along one edge
const PULSE_SPAWN_STAGGER = 3.2; // spread of pulse spawn times after the edges finish
const EDGE_JITTER = 0.4; // tiny per-edge randomness on top of the edge sweep
const EDGE_FLASH_BOOST = 20.0; // extra brightness overshoot as each edge-slot ignites (the "startup pulse")
const EDGE_RESTING_OPACITY = 0.05; // shared by the resting edge material and the pulse's own floor color

// ---- Wormhole pulses: rare straight-line links cutting through the
// sphere's interior between two far-apart random nodes ----
const WORMHOLE_COUNT = 2; // how many can be active/traveling at once
const WORMHOLE_MIN_INTERVAL = 2; // seconds between a slot's own trigger events
const WORMHOLE_MAX_INTERVAL = 4;
const WORMHOLE_SPEED_MIN = 0.5; // fraction of the link crossed per second
const WORMHOLE_SPEED_MAX = 2.0;
const WORMHOLE_GLOW_WIDTH = 1.0; // width (in link-parametric units) of the glow peak
const WORMHOLE_RANGE_PAD = WORMHOLE_GLOW_WIDTH * 2.2; // same fade-in/out-past-the-ends trick as the roaming pulses
const WORMHOLE_BRIGHTNESS = 8.0;
const WORMHOLE_MIN_DISTANCE = RADIUS * 1.4; // require a genuinely long, cross-sphere link
const WORMHOLE_MAX_ATTEMPTS = 12; // random-sampling tries before settling for the farthest pair found

export function createGeoSphereField() {
  const { vertices, edges } = buildGeodesicTopology(RADIUS, DETAIL);
  const group = new THREE.Group();
  group.position.z = GROUP_Z_OFFSET;
  const paletteCycler = createPaletteCycler();
  const tmpColor = new THREE.Color();
  const tmpFloor = new THREE.Color();

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
  // cached per-frame so edges can read each endpoint's *actual* current
  // color (flicker/glitch/ignite and all) instead of computing their own
  const nodeColors = vertices.map(() => new THREE.Color());
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
    const sourceStart =
      edgePhaseStart +
      edgeDistRatio * EDGE_SWEEP +
      (Math.random() - 0.5) * EDGE_JITTER;
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
    opacity: EDGE_RESTING_OPACITY,
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
  }));

  // which edges currently have a live pulse traveling on them — the
  // resting edge underneath gets hidden for those, so it doesn't z-fight
  // (flicker) with the pulse's own coincident line geometry
  const edgeOccupiedByPulse = new Uint8Array(edges.length);

  // ---- Wormhole pulses: a small fixed pool, reused rather than truly
  // created/destroyed each time — a slot goes active, animates once across
  // a straight line through the sphere's interior, then goes fully dark
  // and waits for its own next scheduled trigger. Same Gaussian-trail
  // technique as the roaming pulses, just with two random far-apart nodes
  // as endpoints instead of a mesh edge.
  const wormholePositions = new Float32Array(
    WORMHOLE_COUNT * PULSE_SEGMENTS * 2 * 3
  );
  const wormholeColors = new Float32Array(
    WORMHOLE_COUNT * PULSE_SEGMENTS * 2 * 3
  );
  const wormholeGeometry = new THREE.BufferGeometry();
  wormholeGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(wormholePositions, 3)
  );
  wormholeGeometry.setAttribute(
    "color",
    new THREE.BufferAttribute(wormholeColors, 3)
  );
  const wormholeMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 1,
  });
  const wormholeLines = new THREE.LineSegments(
    wormholeGeometry,
    wormholeMaterial
  );
  group.add(wormholeLines);

  function pickFarNodePair() {
    let best = null;
    for (let attempt = 0; attempt < WORMHOLE_MAX_ATTEMPTS; attempt++) {
      const nodeA = Math.floor(Math.random() * vertices.length);
      const nodeB = Math.floor(Math.random() * vertices.length);
      if (nodeA === nodeB) continue;
      const dist = vertices[nodeA].distanceTo(vertices[nodeB]);
      if (dist >= WORMHOLE_MIN_DISTANCE) return { nodeA, nodeB };
      if (!best || dist > best.dist) best = { nodeA, nodeB, dist };
    }
    return best; // farthest pair found, if none cleared the threshold
  }

  const wormholeState = Array.from({ length: WORMHOLE_COUNT }, () => ({
    active: false,
    nodeA: 0,
    nodeB: 1,
    t: -WORMHOLE_RANGE_PAD,
    speed: 0,
    nextTriggerAt:
      fullyLitAt +
      WORMHOLE_MIN_INTERVAL +
      Math.random() * (WORMHOLE_MAX_INTERVAL - WORMHOLE_MIN_INTERVAL),
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
      nodeColors[i].copy(tmpColor);
    }
    nodeMesh.instanceMatrix.needsUpdate = true;
    nodeMesh.instanceColor.needsUpdate = true;

    // mark every edge a pulse currently occupies, before drawing the
    // resting edges — those get hidden below instead of coinciding with
    // the pulse's own geometry. Marked regardless of spawned state: the
    // pulse's trail sits on this edge (now rendering its dim floor color)
    // from the moment it's assigned, not just once its glow becomes visible
    edgeOccupiedByPulse.fill(0);
    for (let i = 0; i < PULSE_COUNT; i++) {
      edgeOccupiedByPulse[pulseState[i].edgeIndex] = 1;
    }

    // edges — each end takes its color straight from that endpoint's actual
    // current node color, so the GPU's own per-vertex interpolation across
    // the line draws a genuine node-to-node gradient for free
    const colorAttr = edgeGeometry.attributes.color;
    for (let i = 0; i < edges.length; i++) {
      const [a, b] = edges[i];
      const occupied = edgeOccupiedByPulse[i];

      for (let slot = 0; slot < 2; slot++) {
        const idx = i * 2 + slot;

        if (occupied) {
          colorAttr.setXYZ(idx, 0, 0, 0);
          continue;
        }

        const igniteT = Math.min(
          Math.max((elapsed - edgeSlotIgniteStart[idx]) / IGNITE_FADE, 0),
          1
        );
        const igniteProgress = smoothstep(igniteT);
        // brief brightness overshoot as this slot ignites — zero at both
        // ends (t=0 matches the held/dark state, t=1 settles exactly back
        // to normal resting brightness), peaking mid-fade — reads as a
        // "startup pulse" flashing through as the wave passes, using only
        // the existing 2-verts-per-edge buffer instead of dedicated
        // per-edge pulse geometry (which wouldn't scale to ~30k edges)
        const flashBump = Math.sin(Math.PI * igniteT) ** 2 * EDGE_FLASH_BOOST;
        const intensity = igniteProgress + flashBump;
        const source = nodeColors[slot === 0 ? a : b];
        colorAttr.setXYZ(
          idx,
          source.r * intensity,
          source.g * intensity,
          source.b * intensity
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

      // same gradient the resting edge itself shows at this position —
      // not an independent color, so it always matches its host edge
      const clampedT = Math.min(Math.max(pulse.t, 0), 1);
      tmpColor.lerpColors(nodeColors[a], nodeColors[b], clampedT);
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

        // the resting edge underneath this segment is hidden (see the
        // occupied-edge check above), so bake its dim appearance in here
        // as a floor — the pulse geometry alone then reproduces what both
        // layers used to show together, without the two ever coinciding
        tmpFloor.lerpColors(nodeColors[a], nodeColors[b], localT0);
        tmpFloor.multiplyScalar(EDGE_RESTING_OPACITY);
        pulseColorAttr.setXYZ(
          segIndex * 2,
          tmpFloor.r + tmpColor.r * intensity0,
          tmpFloor.g + tmpColor.g * intensity0,
          tmpFloor.b + tmpColor.b * intensity0
        );
        tmpFloor.lerpColors(nodeColors[a], nodeColors[b], localT1);
        tmpFloor.multiplyScalar(EDGE_RESTING_OPACITY);
        pulseColorAttr.setXYZ(
          segIndex * 2 + 1,
          tmpFloor.r + tmpColor.r * intensity1,
          tmpFloor.g + tmpColor.g * intensity1,
          tmpFloor.b + tmpColor.b * intensity1
        );
      }
    }
    pulsePosAttr.needsUpdate = true;
    pulseColorAttr.needsUpdate = true;

    // wormholes — rare straight-line links cutting through the sphere's
    // interior; each slot spawns, animates once, then goes fully dark and
    // waits for its own next scheduled trigger
    const wormholePosAttr = wormholeGeometry.attributes.position;
    const wormholeColorAttr = wormholeGeometry.attributes.color;
    for (let i = 0; i < WORMHOLE_COUNT; i++) {
      const w = wormholeState[i];

      if (!w.active && elapsed >= w.nextTriggerAt) {
        const pair = pickFarNodePair();
        w.nodeA = pair.nodeA;
        w.nodeB = pair.nodeB;
        w.t = -WORMHOLE_RANGE_PAD;
        w.speed =
          WORMHOLE_SPEED_MIN +
          Math.random() * (WORMHOLE_SPEED_MAX - WORMHOLE_SPEED_MIN);
        w.active = true;
      }

      if (w.active) {
        w.t += w.speed * dt;
        if (w.t >= 1 + WORMHOLE_RANGE_PAD) {
          w.active = false;
          w.nextTriggerAt =
            elapsed +
            WORMHOLE_MIN_INTERVAL +
            Math.random() * (WORMHOLE_MAX_INTERVAL - WORMHOLE_MIN_INTERVAL);
        }
      }

      if (w.active) {
        tmpColor.lerpColors(
          nodeColors[w.nodeA],
          nodeColors[w.nodeB],
          Math.min(Math.max(w.t, 0), 1)
        );
        tmpColor.multiplyScalar(WORMHOLE_BRIGHTNESS);
        if (inPaletteGlitch) {
          tmpColor.multiplyScalar(Math.random() < 0.5 ? 0.1 : 2.2);
        }
      }

      for (let k = 0; k < PULSE_SEGMENTS; k++) {
        const segIndex = i * PULSE_SEGMENTS + k;

        if (!w.active) {
          wormholeColorAttr.setXYZ(segIndex * 2, 0, 0, 0);
          wormholeColorAttr.setXYZ(segIndex * 2 + 1, 0, 0, 0);
          continue;
        }

        const localT0 = k / PULSE_SEGMENTS;
        const localT1 = (k + 1) / PULSE_SEGMENTS;

        dummy.position.lerpVectors(
          vertices[w.nodeA],
          vertices[w.nodeB],
          localT0
        );
        wormholePosAttr.setXYZ(
          segIndex * 2,
          dummy.position.x,
          dummy.position.y,
          dummy.position.z
        );
        dummy.position.lerpVectors(
          vertices[w.nodeA],
          vertices[w.nodeB],
          localT1
        );
        wormholePosAttr.setXYZ(
          segIndex * 2 + 1,
          dummy.position.x,
          dummy.position.y,
          dummy.position.z
        );

        const intensity0 = Math.exp(
          -(((localT0 - w.t) / WORMHOLE_GLOW_WIDTH) ** 2)
        );
        const intensity1 = Math.exp(
          -(((localT1 - w.t) / WORMHOLE_GLOW_WIDTH) ** 2)
        );

        wormholeColorAttr.setXYZ(
          segIndex * 2,
          tmpColor.r * intensity0,
          tmpColor.g * intensity0,
          tmpColor.b * intensity0
        );
        wormholeColorAttr.setXYZ(
          segIndex * 2 + 1,
          tmpColor.r * intensity1,
          tmpColor.g * intensity1,
          tmpColor.b * intensity1
        );
      }
    }
    wormholePosAttr.needsUpdate = true;
    wormholeColorAttr.needsUpdate = true;

    return inPaletteGlitch;
  }

  return { mesh: group, update };
}
