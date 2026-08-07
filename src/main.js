import "./ui/style.css";
import { initScrollReveal } from "./ui/reveal.js";
import { initSectionRail } from "./ui/sectionRail.js";

initScrollReveal();
initSectionRail();

const emailLink = document.getElementById("email-link");
const emailLabel = emailLink.querySelector(".social-label");
const defaultEmailLabel = emailLabel.textContent;
const emailAddress = emailLink.href.replace(/^mailto:/, "");
let emailRevertTimeoutId = null;

emailLink.addEventListener("click", (e) => {
  e.preventDefault();
  navigator.clipboard.writeText(emailAddress).then(
    () => {
      emailLabel.textContent = "Copied!";
      clearTimeout(emailRevertTimeoutId);
      emailRevertTimeoutId = window.setTimeout(() => {
        emailLabel.textContent = defaultEmailLabel;
      }, 1800);
    },
    () => {
      // clipboard permission denied/unavailable — fall back to the plain mailto link
      window.location.href = emailLink.href;
    }
  );
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

// ---- Renderer (loaded last, on purpose) ----
// three.js + the scene modules are by far the heaviest thing on this page.
// A dynamic import() puts them in their own chunk that starts fetching here
// but doesn't block the lightweight UI wiring above — on a slow connection
// the resume content, nav, and buttons are already interactive while the
// WebGL bundle is still coming down the wire.
const sceneButtons = document.querySelectorAll(".scene-btn");

function setActiveSceneButton(sceneId) {
  sceneButtons.forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.scene === sceneId);
  });
}

import("./rendering/background.js").then(({ createBackground }) => {
  const canvas = document.getElementById("bg");
  const background = createBackground(canvas);
  setActiveSceneButton(background.getActiveSceneId());

  sceneButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      background.setScene(btn.dataset.scene);
      setActiveSceneButton(btn.dataset.scene);
    });
  });

  // tints the active button's pulsing glow with the scene's current color —
  // only the active scene is actually rendering, so only its button has
  // anything live to sample from
  if (!prefersReducedMotion) {
    function hexToRgbTriplet(hex) {
      const n = parseInt(hex.slice(1), 16);
      return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
    }

    function tickGlowColor() {
      const activeBtn = document.querySelector(".scene-btn.is-active");
      if (activeBtn) {
        activeBtn.style.setProperty(
          "--live-rgb",
          hexToRgbTriplet(background.getLiveColor())
        );
      }
      requestAnimationFrame(tickGlowColor);
    }
    tickGlowColor();
  }
});
