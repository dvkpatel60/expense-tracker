/**
 * happy-dom does no layout, so every element reports a zero-size box and any
 * virtualized list renders an empty window. Give elements a plausible box.
 *
 * The size has to vary: a flat value makes every row as tall as the scroll
 * container, so the virtualizer windows down to two items. Rows carry
 * data-index, so measure those at row height and everything else at viewport
 * height.
 */
const ROW_HEIGHT = 68;
const VIEWPORT = 640;

function rect(width: number, height: number): DOMRect {
  return {
    x: 0, y: 0, top: 0, left: 0, right: width, bottom: height,
    width, height, toJSON: () => ({}),
  };
}

Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
  const isRow = this.hasAttribute("data-index");
  return rect(480, isRow ? ROW_HEIGHT : VIEWPORT);
};

Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 480 });
Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 480 });
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return this.hasAttribute("data-index") ? ROW_HEIGHT : VIEWPORT;
  },
});
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return this.hasAttribute("data-index") ? ROW_HEIGHT : VIEWPORT;
  },
});

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}
