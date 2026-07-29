export function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

export function easeInOutQuint(t) {
  return t < 0.5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2;
}
