import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { PixelShiftGlitchPass } from "./pixelShiftGlitchPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { createCubeField } from "./cubes.js";
import { createGeoSphereField } from "./geoSphere.js";
import { createMorphMesh } from "./morphMesh.js";
import { BASE_COLOR_HEX } from "./palette.js";

const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;

const SCENE_SWAP_FADE_MS = 400; // must match #scene-fade-overlay's CSS transition duration

const DEFAULT_BLOOM = { strength: 1.0, radius: 1.0, threshold: 0.0 };

// how far pointer/tilt parallax rotates the scene, shared across all scenes
const PARALLAX_MAX_ROT_Y = 0.03;
const PARALLAX_MAX_ROT_X = 0.02;

// shared by all scenes — matches BASE_COLOR_HEX so fog blends to the same
// base tone as the background; density is exponential falloff (higher =
// fog starts closer in)
const FOG_COLOR = BASE_COLOR_HEX;
const FOG_DENSITY = 0.03;

// Each factory returns { mesh: Object3D, update(elapsed), bloom? }. `bloom`
// is optional — scenes that don't set it just get DEFAULT_BLOOM. Listed
// here so adding a scene is just one more entry — background.js and the
// scene-picker UI both stay generic instead of hardcoding scene names.
export const SCENES = [
  { id: "cubes", factory: createCubeField },
  { id: "network", factory: createGeoSphereField },
  { id: "morph", factory: createMorphMesh },
];

function disposeObject3D(object) {
  object.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];
      materials.forEach((m) => m.dispose());
    }
  });
}

export function createBackground(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BASE_COLOR_HEX);
  scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);

  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  camera.position.set(0, 0, 9);

  const sceneGroup = new THREE.Group();
  scene.add(sceneGroup);

  const clock = new THREE.Clock();
  const fadeOverlay = document.getElementById("scene-fade-overlay");

  let currentMesh = null;
  let updateField = () => false;
  let activeSceneId = null;
  // clock time the current scene was loaded — update() always sees
  // elapsed-since-load, so every load (including swaps) replays the full
  // intro from scratch instead of jumping straight to "settled"
  let sceneStartTime = 0;
  let pendingSceneId = null; // redirected mid-fade clicks just overwrite this
  let fadeTimeoutId = null;

  const renderTarget = new THREE.WebGLRenderTarget(
    window.innerWidth,
    window.innerHeight,
    { samples: 4 }
  );
  const composer = new EffectComposer(renderer, renderTarget);
  composer.addPass(new RenderPass(scene, camera));
  const glitchPass = new PixelShiftGlitchPass();
  composer.addPass(glitchPass);
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    DEFAULT_BLOOM.strength,
    DEFAULT_BLOOM.radius,
    DEFAULT_BLOOM.threshold
  );
  composer.addPass(bloomPass);

  function loadScene(sceneId) {
    const entry = SCENES.find((s) => s.id === sceneId) ?? SCENES[0];

    if (currentMesh) {
      sceneGroup.remove(currentMesh);
      disposeObject3D(currentMesh);
    }

    const { mesh, update, bloom } = entry.factory();
    sceneGroup.add(mesh);
    currentMesh = mesh;
    updateField = update;
    activeSceneId = entry.id;
    sceneStartTime = clock.getElapsedTime();

    const { strength, radius, threshold } = { ...DEFAULT_BLOOM, ...bloom };
    bloomPass.strength = strength;
    bloomPass.radius = radius;
    bloomPass.threshold = threshold;

    // reset accumulated parallax tilt so the new scene starts flat
    sceneGroup.rotation.set(0, 0, 0);

    if (prefersReducedMotion) {
      // skip the intro/drift animation entirely — jump straight to the
      // settled, fully-lit resting state and never animate again
      updateField(60);
    }
  }

  function setScene(sceneId) {
    if (prefersReducedMotion) {
      loadScene(sceneId);
      return;
    }

    if (sceneId === activeSceneId && pendingSceneId === null) return;

    // redirect the in-flight transition's target instead of restarting the
    // timer — clicking scene 3 mid-fade to scene 2 just forgets scene 2 and
    // lands on scene 3 when the *original* fade completes
    pendingSceneId = sceneId;
    if (fadeTimeoutId !== null) return;

    // a plain opaque DOM overlay sidesteps every material/transparency edge
    // case that fading individual meshes would hit
    fadeOverlay.classList.add("is-active");
    fadeTimeoutId = window.setTimeout(() => {
      loadScene(pendingSceneId);
      pendingSceneId = null;
      fadeTimeoutId = null;

      // reveal instantly — the new scene already starts fully black and
      // runs its own intro, so fading the overlay back too would just
      // double the time spent staring at a black screen
      fadeOverlay.style.transition = "none";
      fadeOverlay.classList.remove("is-active");
      void fadeOverlay.offsetHeight; // flush styles so "none" actually applies
      fadeOverlay.style.transition = "";
    }, SCENE_SWAP_FADE_MS);
  }

  loadScene(SCENES[Math.floor(Math.random() * SCENES.length)].id);

  // ---- Parallax: pointer / device orientation drive a target tilt,
  // scroll position drives a slow rotation + camera drift ----
  const target = { rotX: 0, rotY: 0 };
  const current = { rotX: 0, rotY: 0 };

  if (!prefersReducedMotion) {
    window.addEventListener("pointermove", (e) => {
      // touch input also fires pointermove — ignore it so a finger drag
      // doesn't fight with deviceorientation for the same target values
      if (e.pointerType && e.pointerType !== "mouse") return;

      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = (e.clientY / window.innerHeight) * 2 - 1;
      target.rotY = nx * PARALLAX_MAX_ROT_Y;
      target.rotX = ny * PARALLAX_MAX_ROT_X;
    });

    window.addEventListener("deviceorientation", (e) => {
      if (e.beta == null || e.gamma == null) return;
      target.rotX = THREE.MathUtils.clamp(e.beta / 90, -1, 1) * PARALLAX_MAX_ROT_X;
      target.rotY = THREE.MathUtils.clamp(e.gamma / 90, -1, 1) * PARALLAX_MAX_ROT_Y;
    });
  }

  function scrollProgress() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    return max > 0 ? window.scrollY / max : 0;
  }

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
  });

  function tick() {
    const elapsed = clock.getElapsedTime();

    if (!prefersReducedMotion) {
      const inPaletteGlitch = updateField(elapsed - sceneStartTime);
      glitchPass.goWild = inPaletteGlitch;

      current.rotX += (target.rotX - current.rotX) * 0.04;
      current.rotY += (target.rotY - current.rotY) * 0.04;
      sceneGroup.rotation.x = current.rotX;
      sceneGroup.rotation.y = current.rotY;

      const p = scrollProgress();
      camera.position.y = 3 - p * 6;
    }

    composer.render();
    requestAnimationFrame(tick);
  }
  tick();

  return {
    renderer,
    scene,
    camera,
    composer,
    setScene,
    getActiveSceneId: () => activeSceneId,
  };
}
