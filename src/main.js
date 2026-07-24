import "./style.css";
import { createBackground } from "./background.js";
import { initScrollReveal } from "./reveal.js";

const canvas = document.getElementById("bg");
createBackground(canvas);
initScrollReveal();

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
