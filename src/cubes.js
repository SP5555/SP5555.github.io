import * as THREE from "three";
import { smoothstep, easeInOutQuint } from "./utils.js";
import { createPaletteCycler, BLACK, sampleCyclingColor } from "./palette.js";

const GRID_Y = -5;
const GRID_Z_OFFSET = -40; // push the whole field behind the camera's frustum start
const HOLD = 0.5; // grid sits still & dark before the wave starts
const WAVE_SWEEP = 1.4; // time for the light-up wave to cross the whole grid
const IGNITE_FADE = 0.6; // black -> lit duration, per cube
const PAUSE_AFTER_LIGHT = -1.0; // gap between "everything lit" and the throw phase starting (negative = starts slightly before that point)
const THROW_STAGGER = 2.0; // spread of throw start times across the field
const THROW_PHASE_START =
  HOLD + WAVE_SWEEP + IGNITE_FADE + PAUSE_AFTER_LIGHT;
const DRIFT_RAMP = 0.6; // fade the floating drift in smoothly after landing
const GRID_SPACING = 2.4;
const SIDE_JITTER = 1.5; // max lateral drift from a cube's grid column/row
const LEVITATE_MIN = 1; // minimum height above the floor for resting cubes
const LEVITATE_RANGE = 14; // spread of resting heights above that minimum
const IGNITE_JITTER = 0.2; // tiny per-cube randomness on top of the wave
const FLICKER_MIN_INTERVAL = 4; // seconds between a cube's flicker events
const FLICKER_MAX_INTERVAL = 60;
const FLICKER_DURATION = 0.15; // how long the strobe itself lasts

const CUBE_SCALE = 1.2;

// ---- Breathing wave: a dim-to-black brightness ripple that periodically
// expands outward from roughly where the camera sits, through the whole field ----
const BREATHE_INTERVAL_MIN = 6; // seconds between waves
const BREATHE_INTERVAL_MAX = 16;
const BREATHE_FIRST_DELAY = 8; // don't start until the boot sequence has settled
const BREATHE_SWEEP_DURATION = 0.8; // time for the ripple to reach the farthest cube
const BREATHE_PULSE_WIDTH = 0.6; // how long each cube's own bump lasts as the wave passes
const BREATHE_DARKNESS = 0.4; // 0.0 = breathe to full black, 1.0 = breathe without changing color
const CAMERA_APPROX = new THREE.Vector3(0, 0, 9); // matches background.js's camera.position

export function createCubeField({ gridCols = 40, gridRows = 40 } = {}) {
  const count = gridCols * gridRows;
  const geometry = new THREE.BoxGeometry(0.4, 0.4, 0.4);
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const mesh = new THREE.InstancedMesh(geometry, material, count);

  const dummy = new THREE.Object3D();
  const tmpColor = new THREE.Color();
  const flightPos = new THREE.Vector3();
  const instances = [];
  const paletteCycler = createPaletteCycler();

  let nextBreatheAt =
    BREATHE_FIRST_DELAY +
    Math.random() * (BREATHE_INTERVAL_MAX - BREATHE_INTERVAL_MIN);
  let breatheStartTime = null;

  const cols = gridCols;
  const rows = gridRows;
  const spacing = GRID_SPACING;

  let maxDist = 1;
  let maxCameraDist = 1;

  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const gridPos = new THREE.Vector3(
      (col - (cols - 1) / 2) * spacing,
      GRID_Y,
      (row - (rows - 1) / 2) * spacing + GRID_Z_OFFSET
    );

    const restPosition = new THREE.Vector3(
      gridPos.x + (Math.random() - 0.5) * SIDE_JITTER,
      GRID_Y + LEVITATE_MIN + Math.random() * LEVITATE_RANGE,
      gridPos.z + (Math.random() - 0.5) * SIDE_JITTER
    );

    const dist = Math.abs(gridPos.x);
    if (dist > maxDist) maxDist = dist;

    const cameraDist = restPosition.distanceTo(CAMERA_APPROX);
    if (cameraDist > maxCameraDist) maxCameraDist = cameraDist;

    const rotationSpeed = new THREE.Vector3(
      (Math.random() - 0.5) * 0.4,
      (Math.random() - 0.5) * 0.4,
      (Math.random() - 0.5) * 0.4
    );
    const tumbleAxis = new THREE.Vector3(
      Math.random() - 0.5,
      Math.random() - 0.5,
      Math.random() - 0.5
    );

    instances.push({
      gridPos,
      restPosition,
      dist,
      cameraDist,
      rotationSpeed,
      tumbleAxis,
      driftPhase: Math.random() * Math.PI * 2,
      driftSpeed: 0.15 + Math.random() * 0.25,
      colorPhase: Math.random() * paletteCycler.palette.length,
      colorSpeed: 0.04 + Math.random() * 0.08,
      throwDuration: 3.0 + Math.random() * 0.5,
      igniteJitter: (Math.random() - 0.5) * IGNITE_JITTER,
      nextFlickerAt:
        FLICKER_MIN_INTERVAL +
        Math.random() * (FLICKER_MAX_INTERVAL - FLICKER_MIN_INTERVAL),
      flickerUntil: -Infinity,
    });

    dummy.position.copy(gridPos);
    dummy.scale.setScalar(CUBE_SCALE);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;

  function update(elapsed) {
    const inPaletteGlitch = paletteCycler.update(elapsed);
    const palette = paletteCycler.palette;

    if (elapsed >= nextBreatheAt) {
      breatheStartTime = elapsed;
      nextBreatheAt =
        elapsed +
        BREATHE_INTERVAL_MIN +
        Math.random() * (BREATHE_INTERVAL_MAX - BREATHE_INTERVAL_MIN);
    }

    for (let i = 0; i < count; i++) {
      const inst = instances[i];
      const distRatio = inst.dist / maxDist;

      let breatheBump = 0;
      if (breatheStartTime !== null) {
        const arrivalTime =
          breatheStartTime +
          (inst.cameraDist / maxCameraDist) * BREATHE_SWEEP_DURATION;
        const bumpT = Math.min(
          Math.max((elapsed - arrivalTime) / BREATHE_PULSE_WIDTH, 0),
          1
        );
        breatheBump = Math.sin(Math.PI * bumpT) ** 2;
      }

      const igniteStart = HOLD + distRatio * WAVE_SWEEP + inst.igniteJitter;
      const throwStart = THROW_PHASE_START + distRatio * THROW_STAGGER;
      const landTime = throwStart + inst.throwDuration;
      const throwT = Math.min(
        Math.max((elapsed - throwStart) / inst.throwDuration, 0),
        1
      );

      // base spin blends smoothly from 0 (held) to the steady-state rate,
      // with a gentle extra tumble mid-flight that fades back out to zero
      const spinBlend = smoothstep(throwT);
      const tumble = Math.sin(Math.PI * throwT) ** 2 * 2.2;

      dummy.rotation.set(
        elapsed * inst.rotationSpeed.x * spinBlend +
          tumble * inst.tumbleAxis.x,
        elapsed * inst.rotationSpeed.y * spinBlend +
          tumble * inst.tumbleAxis.y,
        elapsed * inst.rotationSpeed.z * spinBlend +
          tumble * inst.tumbleAxis.z
      );

      if (throwT <= 0) {
        flightPos.copy(inst.gridPos);
      } else if (throwT < 1) {
        const eased = easeInOutQuint(throwT);
        flightPos.lerpVectors(inst.gridPos, inst.restPosition, eased);
      } else {
        const driftBlend = smoothstep(
          Math.min(Math.max((elapsed - landTime) / DRIFT_RAMP, 0), 1)
        );
        flightPos.set(
          inst.restPosition.x,
          inst.restPosition.y +
            Math.sin(elapsed * inst.driftSpeed + inst.driftPhase) *
              0.1 *
              driftBlend,
          inst.restPosition.z
        );
      }

      dummy.position.copy(flightPos);
      dummy.scale.setScalar(CUBE_SCALE);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      const igniteT = Math.min(
        Math.max((elapsed - igniteStart) / IGNITE_FADE, 0),
        1
      );
      const igniteProgress = smoothstep(igniteT);

      if (igniteProgress >= 1 && elapsed >= inst.nextFlickerAt) {
        inst.colorPhase = Math.random() * palette.length;
        inst.flickerUntil = elapsed + FLICKER_DURATION;
        inst.nextFlickerAt =
          elapsed +
          FLICKER_MIN_INTERVAL +
          Math.random() * (FLICKER_MAX_INTERVAL - FLICKER_MIN_INTERVAL);
      }

      const t = elapsed * inst.colorSpeed + inst.colorPhase;
      sampleCyclingColor(palette, t, tmpColor);
      tmpColor.lerpColors(BLACK, tmpColor, igniteProgress);

      if (elapsed < inst.flickerUntil) {
        tmpColor.multiplyScalar(Math.random() < 0.5 ? 0.15 : 1.8);
      }

      if (inPaletteGlitch) {
        tmpColor.multiplyScalar(Math.random() < 0.5 ? 0.1 : 2.2);
      }

      tmpColor.lerpColors(tmpColor, BLACK, breatheBump * (1 - BREATHE_DARKNESS));

      mesh.setColorAt(i, tmpColor);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;

    return inPaletteGlitch;
  }

  return { mesh, update };
}
