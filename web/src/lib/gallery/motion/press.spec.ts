import { installPressFeedback, lastPressPoint, pressScale } from '$lib/gallery/motion/press';

describe('pressScale', () => {
  it('dips small controls the most, capped at 0.92', () => {
    expect(pressScale(24)).toBe(0.92);
    expect(pressScale(40)).toBe(0.92);
  });

  it('squishes about 5px across mid-sized buttons', () => {
    expect(pressScale(100)).toBeCloseTo(0.95);
  });

  it('barely moves wide rows', () => {
    expect(pressScale(500)).toBe(0.99);
    expect(pressScale(2000)).toBe(0.99);
  });
});

describe('installPressFeedback', () => {
  let uninstall: () => void;
  let animate: ReturnType<typeof vi.fn>;

  const press = (element: Element) => {
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 20 }));
  };

  beforeEach(() => {
    animate = vi.fn(() => ({ cancel: vi.fn() }));
    Element.prototype.animate = animate as unknown as Element['animate'];
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 36 } as DOMRect);
    uninstall = installPressFeedback();
  });

  afterEach(() => {
    uninstall();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('squishes a pressed button and springs it back on release', () => {
    document.body.innerHTML = '<button><span id="label">Save</span></button>';
    press(document.querySelector('#label')!);

    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0][0]).toEqual([{ scale: 1 }, { scale: 0.95 }]);
    expect(document.querySelector('button')!.dataset.justPressed).toBe('');

    document.dispatchEvent(new PointerEvent('pointerup'));
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate.mock.calls[1][0][1]).toEqual({ scale: 1 });
  });

  it('leaves disabled and opted-out controls alone', () => {
    document.body.innerHTML = '<button disabled>a</button><div data-no-press><button>b</button></div>';
    for (const button of document.querySelectorAll('button')) {
      press(button);
    }
    expect(animate).not.toHaveBeenCalled();
  });

  it('leaves surfaces larger than a control alone', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1200, height: 800 } as DOMRect);
    document.body.innerHTML = '<button>backdrop</button>';
    press(document.querySelector('button')!);
    expect(animate).not.toHaveBeenCalled();
  });

  it('records where the pointer pressed, and forgets it on keyboard input', () => {
    document.body.innerHTML = '<p>text</p>';
    press(document.querySelector('p')!);
    expect(lastPressPoint(1000)).toMatchObject({ x: 10, y: 20 });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }));
    expect(lastPressPoint(1000)).toBeUndefined();
  });
});
