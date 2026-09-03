import { useEffect, useRef, useState } from "react";
import type { Cents } from "../../core/money.js";
import { dollars } from "../format.js";

/**
 * Counts to a new value when it changes. Motion is reserved for value changes
 * because that is the one moment where showing what moved helps.
 */
export function Money({ value, className }: { value: Cents; className?: string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);

  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || from.current === value) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    const origin = from.current;
    const delta = value - origin;
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 420);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(Math.round(origin + delta * eased) as Cents);
      if (t < 1) frame = requestAnimationFrame(tick);
      else from.current = value;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return <span className={className}>{dollars(shown)}</span>;
}
