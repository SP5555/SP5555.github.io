import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { createCubeField } from "./cubes.js";

const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;

export function createBackground(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.fog = new THREE.FogExp2(0x000000, 0.038);

  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  camera.position.set(0, 0, 9);

  const cubeGroup = new THREE.Group();
  const { mesh: cubeMesh, update: updateCubes } = createCubeField();
  cubeGroup.add(cubeMesh);
  scene.add(cubeGroup);

  if (prefersReducedMotion) {
    // skip the intro/drift animation entirely — jump straight to the
    // settled, fully-lit resting state and never animate again
    updateCubes(60);
  }

  const renderTarget = new THREE.WebGLRenderTarget(
    window.innerWidth,
    window.innerHeight,
    { samples: 4 }
  );
  const composer = new EffectComposer(renderer, renderTarget);
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    1.5, // strength
    0.6, // radius
    0.0  // threshold
  );
  composer.addPass(bloomPass);

  // ---- Parallax: pointer / device orientation drive a target tilt,
  // scroll position drives a slow rotation + camera drift ----
  const target = { rotX: 0, rotY: 0 };
  const current = { rotX: 0, rotY: 0 };

  if (!prefersReducedMotion) {
    window.addEventListener("pointermove", (e) => {
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = (e.clientY / window.innerHeight) * 2 - 1;
      target.rotY = nx * 0.12;
      target.rotX = ny * 0.08;
    });

    window.addEventListener("deviceorientation", (e) => {
      if (e.beta == null || e.gamma == null) return;
      target.rotX = THREE.MathUtils.clamp(e.beta / 90, -1, 1) * 0.08;
      target.rotY = THREE.MathUtils.clamp(e.gamma / 90, -1, 1) * 0.12;
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

  const clock = new THREE.Clock();

  function tick() {
    const elapsed = clock.getElapsedTime();

    if (!prefersReducedMotion) {
      updateCubes(elapsed);

      current.rotX += (target.rotX - current.rotX) * 0.04;
      current.rotY += (target.rotY - current.rotY) * 0.04;
      cubeGroup.rotation.x = current.rotX;
      cubeGroup.rotation.y = current.rotY;

      const p = scrollProgress();
      camera.position.y = 3 - p * 6;
    }

    composer.render();
    requestAnimationFrame(tick);
  }
  tick();

  return { renderer, scene, camera, composer };
}
