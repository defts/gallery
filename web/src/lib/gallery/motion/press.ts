import { duration, ease, prefersReducedMotion, spring, springEasing } from '$lib/gallery/motion/tokens';

/**
 * Site-wide press feedback: every button-like control squishes slightly while held and springs back on
 * release. It runs from document listeners, so upstream components get it without being edited.
 *
 * Opt a custom element in with `data-press`, or out with `data-no-press` (on it or any ancestor).
 */
export const PRESSABLE =
  'button, [role="button"], [role="switch"], [role="checkbox"], [role="tab"], [role="menuitem"], [role="option"], [data-press]';

/** How long `data-just-pressed` stays after release, so CSS can pop what the press changed. */
export const JUST_PRESSED_MS = 700;

/** Elements larger than this (px²) are surfaces, not controls: a squish would read as the page lurching. */
const MAX_AREA = 600 * 200;

/**
 * Scale for a held control. The squish is about 5px across whatever the width, so icons dip
 * visibly (0.92) and wide rows barely move (0.99).
 */
export const pressScale = (width: number): number => 1 - Math.min(0.08, Math.max(0.01, 5 / Math.max(width, 1)));

export interface PressPoint {
  x: number;
  y: number;
  at: number;
}

let lastPoint: PressPoint | undefined;

/** Where the last pointer press landed, for effects that start from the user's finger (see `celebrate`). */
export const lastPressPoint = (maxAgeMs: number): PressPoint | undefined =>
  lastPoint && performance.now() - lastPoint.at <= maxAgeMs ? lastPoint : undefined;

const findPressable = (target: EventTarget | null): HTMLElement | undefined => {
  if (!(target instanceof Element)) {
    return;
  }
  const element = target.closest<HTMLElement>(PRESSABLE);
  if (
    !element ||
    typeof element.animate !== 'function' ||
    element.closest('[data-no-press]') ||
    element.matches(':disabled, [aria-disabled="true"]') ||
    prefersReducedMotion()
  ) {
    return;
  }
  const { width, height } = element.getBoundingClientRect();
  if (width * height > MAX_AREA) {
    return;
  }
  return element;
};

interface Held {
  element: HTMLElement;
  scale: number;
  startedAt: number;
  animation: Animation;
}

let held: Held | undefined;
const justPressedTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

const markJustPressed = (element: HTMLElement) => {
  clearTimeout(justPressedTimers.get(element));
  element.dataset.justPressed = '';
  justPressedTimers.set(
    element,
    setTimeout(() => delete element.dataset.justPressed, JUST_PRESSED_MS),
  );
};

// `composite: 'add'` multiplies onto any scale the element already has (hover:scale-*, selection),
// so the squish never resets a component's own transform.
const pressIn = (element: HTMLElement) => {
  release();
  const scale = pressScale(element.getBoundingClientRect().width);
  const animation = element.animate([{ scale: 1 }, { scale }], {
    duration: duration.instant,
    easing: ease.standard,
    fill: 'forwards',
    composite: 'add',
  });
  held = { element, scale, startedAt: performance.now(), animation };
  markJustPressed(element);
};

const release = () => {
  if (!held) {
    return;
  }
  const { element, scale, startedAt, animation } = held;
  held = undefined;
  // A quick tap releases before the press-in finished: spring back from where it got to.
  const progress = Math.min(1, (performance.now() - startedAt) / duration.instant);
  const from = 1 + (scale - 1) * progress;
  animation.cancel();
  if (element.isConnected) {
    element.animate([{ scale: from }, { scale: 1 }], {
      duration: spring.gentle.duration,
      easing: springEasing(spring.gentle),
      composite: 'add',
    });
  }
};

const onPointerDown = (event: PointerEvent) => {
  lastPoint = { x: event.clientX, y: event.clientY, at: performance.now() };
  if (event.button !== 0) {
    return;
  }
  const element = findPressable(event.target);
  if (element) {
    pressIn(element);
  }
};

const onKeyDown = (event: KeyboardEvent) => {
  // Whatever happens next was not started by the pointer, so effects must not start from it.
  lastPoint = undefined;
  if (event.repeat || (event.key !== ' ' && event.key !== 'Enter')) {
    return;
  }
  const element = findPressable(event.target);
  if (!element) {
    return;
  }
  pressIn(element);
  // Enter clicks on keydown, so it is a tap; Space clicks on keyup and is held like a pointer.
  if (event.key === 'Enter') {
    release();
  }
};

const onKeyUp = (event: KeyboardEvent) => {
  if (event.key === ' ') {
    release();
  }
};

/** Installs the document listeners. Returns the uninstaller. */
export const installPressFeedback = (target: Document = document): (() => void) => {
  const listeners: [string, EventListener][] = [
    ['pointerdown', onPointerDown as EventListener],
    ['pointerup', release],
    ['pointercancel', release],
    ['dragstart', release],
    ['keydown', onKeyDown as EventListener],
    ['keyup', onKeyUp as EventListener],
  ];
  for (const [type, listener] of listeners) {
    target.addEventListener(type, listener, { capture: true, passive: true });
  }
  const onBlur = () => release();
  addEventListener('blur', onBlur);

  return () => {
    release();
    for (const [type, listener] of listeners) {
      target.removeEventListener(type, listener, { capture: true });
    }
    removeEventListener('blur', onBlur);
  };
};
