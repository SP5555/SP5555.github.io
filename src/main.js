import "./style.css";
import { createBackground } from "./background.js";
import { initScrollReveal } from "./reveal.js";

const canvas = document.getElementById("bg");
const background = createBackground(canvas);
initScrollReveal();

const sceneButtons = document.querySelectorAll(".scene-btn");

function setActiveSceneButton(sceneId) {
  sceneButtons.forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.scene === sceneId);
  });
}
setActiveSceneButton(background.getActiveSceneId());

sceneButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    background.setScene(btn.dataset.scene);
    setActiveSceneButton(btn.dataset.scene);
  });
});

const backToTop = document.getElementById("back-to-top");
const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;

window.addEventListener(
  "scroll",
  () => {
    backToTop.classList.toggle("is-visible", window.scrollY > window.innerHeight * 0.6);
  },
  { passive: true }
);

backToTop.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: prefersReducedMotion ? "auto" : "smooth" });
});
