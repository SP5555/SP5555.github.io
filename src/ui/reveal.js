export function initScrollReveal() {
  const targets = document.querySelectorAll(".reveal");
  if (!targets.length) return;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      }
    },
    // fixed px, not a percentage — a percentage-based bottom margin scales
    // with viewport height, so on very tall/large screens the excluded
    // zone grows large enough that a short trailing element (the footer)
    // can end up permanently stuck inside it once you're scrolled all the
    // way down, with no more scroll distance left to move it out
    { threshold: 0.15, rootMargin: "0px 0px -80px 0px" }
  );

  targets.forEach((el, i) => {
    el.style.transitionDelay = `${(i % 4) * 60}ms`;
    observer.observe(el);
  });
}
