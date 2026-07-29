// Highlights whichever section's dot corresponds to the section currently
// crossing the vertical center of the viewport, and smooth-scrolls to a
// section when its dot is clicked.
export function initSectionRail() {
  const sections = document.querySelectorAll("main section[id]");
  const dots = document.querySelectorAll(".rail-dot");
  if (!sections.length || !dots.length) return;

  const dotFor = new Map();
  dots.forEach((dot) => dotFor.set(dot.dataset.section, dot));

  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  // shrinks the observed region to a thin band around the vertical
  // center, so "active" means "currently crossing the middle of the
  // screen" rather than "any part of it is visible" — the standard,
  // robust technique for scroll-spy nav (avoids multiple sections
  // registering as active at once with a plain full-viewport check)
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const dot = dotFor.get(entry.target.id);
        if (!dot) continue;
        dots.forEach((d) => d.classList.remove("is-active"));
        dot.classList.add("is-active");
      }
    },
    { rootMargin: "-45% 0px -45% 0px", threshold: 0 }
  );

  sections.forEach((section) => observer.observe(section));

  dots.forEach((dot) => {
    dot.addEventListener("click", (e) => {
      e.preventDefault();
      const target = document.getElementById(dot.dataset.section);
      if (!target) return;
      target.scrollIntoView({
        behavior: prefersReducedMotion ? "auto" : "smooth",
        block: "start",
      });
    });
  });
}
