import { quintOut } from 'svelte/easing';
import { duration, prefersReducedMotion } from '$lib/gallery/motion/tokens';

/**
 * Params for Svelte's `slide`/`fade` on fork content that appears inline and pushes the page (a
 * banner, a section): the base duration on the settle curve, or instant under reduced motion.
 * Use it as an intro (`in:`): an outro keeps the element mounted until it finishes, which callers
 * and tests that expect an immediate removal do not.
 */
export const revealMotion = (): { duration: number; easing?: (t: number) => number } =>
  prefersReducedMotion() ? { duration: 0 } : { duration: duration.base, easing: quintOut };
