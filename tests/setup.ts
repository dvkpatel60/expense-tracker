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

/**
 * happy-dom composites nothing, so an animation here is a state update on a
 * timer with no picture at the end of it. Declaring reduced motion is the
 * honest description of this environment, and it keeps the donut drill (which
 * interpolates its arcs in a requestAnimationFrame loop) deterministic instead
 * of leaving setState calls in flight after a test finishes.
 */
if (!globalThis.matchMedia) {
  globalThis.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof matchMedia;
}

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

/**
 * The app asks /api/providers on mount to find out what this deployment can do.
 * happy-dom resolves that relative URL against localhost:3000 and tries to open
 * a socket, so without a default the suite makes real network calls and its
 * behaviour depends on whether anything happens to be listening.
 *
 * Default to "nothing configured", which is the honest answer for a test run.
 * Tests that care stub fetch themselves and win, because they run later.
 */
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/api/providers")) {
    return new Response(JSON.stringify({ providers: [] }), { status: 200 });
  }
  // Analysis is opt-in and needs a key; "not configured" is the honest default.
  if (url.includes("/api/insights")) {
    return new Response(JSON.stringify({ error: "No provider is configured." }), { status: 503 });
  }
  throw new Error(`Unstubbed fetch in tests: ${url}`);
}) as typeof fetch;
