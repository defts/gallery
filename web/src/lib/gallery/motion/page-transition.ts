import type { OnNavigate } from '@sveltejs/kit';
import { prefersReducedMotion } from '$lib/gallery/motion/tokens';

/**
 * Section changes (Photos → Albums → Spaces) crossfade through the View Transitions API, with the
 * sidebar and top bar held still (motion.css names them). Only between different pages: a filter or
 * query change on the same page, and anything opening or closing the asset viewer, swaps instantly,
 * because the viewer has its own motion and a snapshot of the timeline would stall it.
 */

export const shouldCrossfade = (navigation: Pick<OnNavigate, 'from' | 'to' | 'willUnload'>): boolean => {
  const from = navigation.from?.route.id;
  const to = navigation.to?.route.id;
  if (navigation.willUnload || !from || !to || from === to) {
    return false;
  }
  // Every route that can show the asset viewer carries it as an `assetId` param.
  return !navigation.from?.params?.assetId && !navigation.to?.params?.assetId;
};

/** `onNavigate` callback: SvelteKit waits for the returned promise before swapping the page. */
export const crossfadeNavigation = (navigation: OnNavigate): Promise<void> | void => {
  // Older browsers without View Transitions just swap pages.
  // eslint-disable-next-line tscompat/tscompat
  if (typeof document === 'undefined' || !document.startViewTransition || prefersReducedMotion()) {
    return;
  }
  if (!shouldCrossfade(navigation)) {
    return;
  }
  return new Promise((resolve) => {
    // eslint-disable-next-line tscompat/tscompat
    document.startViewTransition(async () => {
      resolve();
      await navigation.complete;
    });
  });
};
