const MAGNETIC_RADIUS = 70; // px — how close the cursor needs to be to start pulling
const MAGNETIC_STRENGTH = 0.35; // fraction of the cursor-to-center distance actually applied
const MAGNETIC_MAX_OFFSET = 10; // px — hard cap so it never yanks the element too far

// Sets --mx/--my instead of the transform property directly, so elements
// that already have their own transform (e.g. .scene-btn:active's scale,
// .back-to-top's slide in/out) can compose it in rather than having it
// silently overwritten.
export function initMagneticButtons() {
  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;
  if (prefersReducedMotion) return;

  const elements = document.querySelectorAll(".magnetic");
  if (!elements.length) return;

  function resetAll() {
    elements.forEach((el) => {
      el.style.setProperty("--mx", "0px");
      el.style.setProperty("--my", "0px");
    });
  }

  window.addEventListener("pointermove", (e) => {
    // touch input also fires pointermove — a magnetic pull based on a
    // finger's transient touch position doesn't make sense
    if (e.pointerType && e.pointerType !== "mouse") return;

    elements.forEach((el) => {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < MAGNETIC_RADIUS) {
        const pull = (1 - dist / MAGNETIC_RADIUS) * MAGNETIC_STRENGTH;
        const offsetX = Math.max(
          Math.min(dx * pull, MAGNETIC_MAX_OFFSET),
          -MAGNETIC_MAX_OFFSET
        );
        const offsetY = Math.max(
          Math.min(dy * pull, MAGNETIC_MAX_OFFSET),
          -MAGNETIC_MAX_OFFSET
        );
        el.style.setProperty("--mx", `${offsetX}px`);
        el.style.setProperty("--my", `${offsetY}px`);
      } else {
        el.style.setProperty("--mx", "0px");
        el.style.setProperty("--my", "0px");
      }
    });
  });

  window.addEventListener("blur", resetAll);
}
