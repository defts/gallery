import { quintOut } from 'svelte/easing';
import { duration, prefersReducedMotion } from '$lib/gallery/motion/tokens';

/**
 * Params for Svelte's `slide`/`fade` on fork content that appears inline and pushes the page (a
 * banner, a section): the base duration on the settle curve, or instant under reduced motion.
 */
export const revealMotion = (): { duration: number; easing?: (t: number) => number } =>
  prefersReducedMotion() ? { duration: 0 } : { duration: duration.base, easing: quintOut };
