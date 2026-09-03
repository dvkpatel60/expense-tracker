import { useEffect, useMemo, useRef, useState } from "react";
import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import { arc, pie } from "d3-shape";
import type { SpendGroup } from "../../core/ledger.js";
import { cents } from "../../core/money.js";
import type { Cents } from "../../core/money.js";
import { categoryColor, dollarsAbs, groupColor } from "../format.js";
import { lensTargetForCategory, lensTargetForGroup } from "./CategoryLens.js";
import type { LensTarget } from "./CategoryLens.js";

const TAU = Math.PI * 2;
const ALL = " all";

interface Slice {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly color: string;
  readonly target: LensTarget;
}

/** The one place the ring reads its timing from. Zero means "do not animate":
 *  either the reader asked for reduced motion, or there is no document to ask
 *  (tests, server render), and a collapsed first frame would be a flash rather
 *  than a transition. Cached because it is read on every drill. */
let cachedDuration: number | null = null;
function motionDuration(): number {
  if (cachedDuration === null) cachedDuration = readDuration();
  return cachedDuration;
}
function readDuration(): number {
  if (typeof window === "undefined" || typeof document === "undefined") return 0;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--dur-slow").trim();
  const ms = raw.endsWith("ms") ? parseFloat(raw) : raw.endsWith("s") ? parseFloat(raw) * 1000 : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** Matches --ease-out closely enough that the ring and the CSS transitions
 *  around it decelerate together; the exact bezier is not worth the code. */
const easeOut = (p: number): number => 1 - (1 - p) ** 3;

/**
 * Spending by group as a ring, or every category at once as a treemap.
 *
 * A ring rather than a pie: the hole is where the period total goes, which is
 * the figure people actually want, and it removes the thin centre wedges that
 * make small slices unreadable. Twenty-one categories are unreadable at either
 * radius, so the ring is fed groups (core/categorize.ts) and drills into one.
 *
 * The drill is animated because a ring that swaps its slices in one frame
 * reads as a different chart rather than the same one, opened. Categories fan
 * out of their group's own wedge and fold back into it, so the wedge that was
 * clicked is visibly the thing that opened.
 *
 * The treemap answers the other half of the problem: a drill shows one group at
 * a time, and a reader comparing Coffee against Fuel should not have to carry a
 * number across two clicks. Every category is on screen at once, sized by your
 * share and shaded within its group's colour family (--grp-* against --cat-*,
 * which is what that scale is for).
 *
 * Both are aria-hidden by design: the ranked list beside them is the same data
 * as text, so a screen reader gets the table and not a pile of unlabelled
 * paths.
 */
export function CategoryDonut({
  groups,
  drilled,
  onDrill,
  onHover,
  onPin,
  size = 220,
}: {
  groups: readonly SpendGroup[];
  /** When set, the ring shows this group's categories instead of the groups. */
  drilled: SpendGroup | null;
  onDrill(group: SpendGroup | null): void;
  onHover(target: LensTarget | null, anchor: DOMRect | null): void;
  onPin(target: LensTarget, anchor: DOMRect): void;
  size?: number;
}) {
  const [mode, setMode] = useState<"ring" | "treemap">("ring");

  const groupSlices = useMemo<Slice[]>(
    () =>
      groups
        .filter((g) => g.yourShare > 0)
        .map((g) => ({
          key: g.groupId,
          label: g.groupId,
          value: g.yourShare,
          color: groupColor(g.groupId),
          target: lensTargetForGroup(g),
        })),
    [groups]
  );

  const slices = useMemo<Slice[]>(() => {
    if (!drilled) return groupSlices;
    return drilled.categories
      .filter((c) => c.yourShare > 0)
      .map((c) => ({
        key: c.categoryId,
        label: c.categoryId,
        value: c.yourShare,
        color: categoryColor(c.categoryId),
        target: lensTargetForCategory(c),
      }));
  }, [groupSlices, drilled]);

  // The drill transition. Both directions run one rule: the anchor is the
  // drilled group's wedge in the *group* layout, and every target slice is
  // interpolated from a copy of itself squeezed into that wedge. Drilling in
  // unfolds out of it; drilling out folds back into it.
  const drillKey = drilled?.groupId ?? ALL;
  const prevKey = useRef(drillKey);
  const anchorId = useRef<string | null>(null);
  const armed = useRef(false);
  const [t, setT] = useState(1);

  if (prevKey.current !== drillKey) {
    anchorId.current = drilled ? drilled.groupId : prevKey.current === ALL ? null : prevKey.current;
    prevKey.current = drillKey;
    // Skip the collapsed first frame entirely when nothing will animate it
    // back out; under reduced motion that frame is the whole animation.
    if (motionDuration() > 0) {
      armed.current = true;
      setT(0);
    }
  }

  useEffect(() => {
    if (!armed.current) return;
    armed.current = false;
    const ms = motionDuration();
    const started = performance.now();
    let raf = 0;
    const step = (now: number): void => {
      const p = Math.min(1, (now - started) / ms);
      setT(p < 1 ? easeOut(p) : 1);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [drillKey]);

  const layout = useMemo(() => pie<Slice>().value((s) => s.value).sort(null).padAngle(0.012), []);
  const groupArcs = useMemo(() => layout(groupSlices as Slice[]), [layout, groupSlices]);
  const arcs = useMemo(
    () => (drilled ? layout(slices as Slice[]) : groupArcs),
    [layout, slices, drilled, groupArcs]
  );

  const total = slices.reduce((n, s) => n + s.value, 0);
  const count = drilled ? drilled.transactionCount : groups.reduce((n, g) => n + g.transactionCount, 0);
  if (slices.length === 0 || total === 0) return null;

  const radius = size / 2;
  const shape = arc<{ startAngle: number; endAngle: number; padAngle: number }>()
    .innerRadius(radius * 0.62)
    .outerRadius(radius)
    .cornerRadius(2);

  const anchorArc = anchorId.current
    ? groupArcs.find((a) => a.data.key === anchorId.current)
    : undefined;
  const base = anchorArc ? anchorArc.startAngle : 0;
  const span = anchorArc ? anchorArc.endAngle - anchorArc.startAngle : TAU;
  const at = (angle: number): number => {
    if (t >= 1) return angle;
    const from = base + (angle / TAU) * span;
    return from + (angle - from) * t;
  };

  return (
    <div className="donut-wrap">
      <div className="chart-modes" role="group" aria-label="Breakdown shape">
        <button
          className={mode === "ring" ? "chart-mode on" : "chart-mode"}
          aria-pressed={mode === "ring"}
          onClick={() => setMode("ring")}
        >
          Ring
        </button>
        <button
          className={mode === "treemap" ? "chart-mode on" : "chart-mode"}
          aria-pressed={mode === "treemap"}
          onClick={() => setMode("treemap")}
        >
          Treemap
        </button>
      </div>

      {mode === "ring" ? (
        <div className="donut" style={{ width: size, height: size }}>
          <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
            <g transform={`translate(${radius}, ${radius})`}>
              {arcs.map((a) => (
                <path
                  key={a.data.key}
                  d={
                    shape({
                      startAngle: at(a.startAngle),
                      endAngle: at(a.endAngle),
                      padAngle: a.padAngle,
                    }) ?? ""
                  }
                  fill={a.data.color}
                  className="donut-slice"
                  onMouseEnter={(e) => onHover(a.data.target, e.currentTarget.getBoundingClientRect())}
                  onMouseLeave={() => onHover(null, null)}
                  onClick={(e) => {
                    if (drilled) onPin(a.data.target, e.currentTarget.getBoundingClientRect());
                    else onDrill(groupFor(groups, a.data.key));
                  }}
                />
              ))}
            </g>
          </svg>
          <div className="donut-centre">
            <span className="donut-total num">{dollarsAbs(cents(total) as Cents)}</span>
            <span className="donut-count">
              {count} {count === 1 ? "purchase" : "purchases"}
            </span>
          </div>
        </div>
      ) : (
        <SpendTreemap groups={groups} onHover={onHover} onPin={onPin} onDrill={onDrill} />
      )}

      <ul className="donut-key">
        {drilled && (
          <li>
            <button className="donut-back" onClick={() => onDrill(null)}>
              &larr; All groups
            </button>
          </li>
        )}
        {mode === "ring" &&
          slices.map((s) => (
            <li key={s.key}>
              <button
                className="donut-key-row"
                onMouseEnter={(e) => onHover(s.target, e.currentTarget.getBoundingClientRect())}
                onMouseLeave={() => onHover(null, null)}
                onFocus={(e) => onHover(s.target, e.currentTarget.getBoundingClientRect())}
                onBlur={() => onHover(null, null)}
                onClick={(e) => {
                  if (drilled) onPin(s.target, e.currentTarget.getBoundingClientRect());
                  else onDrill(groupFor(groups, s.key));
                }}
              >
                <i style={{ background: s.color }} />
                <span className="donut-key-label">{s.label}</span>
                <span className="donut-key-value num">{dollarsAbs(cents(s.value) as Cents)}</span>
                <span className="donut-key-pct num">{Math.round((s.value / total) * 100)}%</span>
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}

interface TreeNode {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly value: number;
  readonly target: LensTarget | null;
  readonly group?: SpendGroup;
  readonly children?: readonly TreeNode[];
}

/**
 * Every category at once, nested inside its group. Area is your share, so the
 * ranking is the picture; colour is the group family, so the six reading-level
 * buckets stay legible even with twenty-one things on screen.
 */
function SpendTreemap({
  groups,
  onHover,
  onPin,
  onDrill,
  width = 280,
  height = 236,
}: {
  groups: readonly SpendGroup[];
  onHover(target: LensTarget | null, anchor: DOMRect | null): void;
  onPin(target: LensTarget, anchor: DOMRect): void;
  onDrill(group: SpendGroup | null): void;
  width?: number;
  height?: number;
}) {
  const nodes = useMemo(() => {
    const root: TreeNode = {
      key: "root",
      label: "",
      color: "",
      value: 0,
      target: null,
      children: groups
        .filter((g) => g.yourShare > 0)
        .map((g) => ({
          key: g.groupId,
          label: g.groupId,
          color: groupColor(g.groupId),
          value: g.yourShare,
          target: lensTargetForGroup(g),
          group: g,
          children: g.categories
            .filter((c) => c.yourShare > 0)
            .map((c) => ({
              key: c.categoryId,
              label: c.categoryId,
              color: categoryColor(c.categoryId),
              value: c.yourShare,
              target: lensTargetForCategory(c),
            })),
        })),
    };

    const rooted = hierarchy<TreeNode>(root, (d) => d.children as TreeNode[] | undefined)
      .sum((d) => (d.children && d.children.length > 0 ? 0 : d.value))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

    return treemap<TreeNode>()
      .tile(treemapSquarify)
      .size([width, height])
      .paddingOuter(3)
      .paddingTop(15)
      .paddingInner(2)
      .round(true)(rooted)
      .descendants();
  }, [groups, width, height]);

  if (nodes.length <= 1) return null;

  return (
    <div className="treemap" style={{ width, height }}>
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
        {nodes
          .filter((n) => n.depth === 1)
          .map((n) => (
            <g key={n.data.key}>
              <rect
                className="tm-group"
                x={n.x0}
                y={n.y0}
                width={Math.max(0, n.x1 - n.x0)}
                height={Math.max(0, n.y1 - n.y0)}
                fill={n.data.color}
                onMouseEnter={(e) =>
                  n.data.target && onHover(n.data.target, e.currentTarget.getBoundingClientRect())
                }
                onMouseLeave={() => onHover(null, null)}
                onClick={() => n.data.group && onDrill(n.data.group)}
              />
              {n.x1 - n.x0 > 46 && (
                <text className="tm-group-label" x={n.x0 + 4} y={n.y0 + 11}>
                  {n.data.label}
                </text>
              )}
            </g>
          ))}
        {nodes
          .filter((n) => n.depth === 2)
          .map((n) => {
            const w = Math.max(0, n.x1 - n.x0);
            const h = Math.max(0, n.y1 - n.y0);
            return (
              <g key={n.data.key}>
                <rect
                  className="tm-cell"
                  x={n.x0}
                  y={n.y0}
                  width={w}
                  height={h}
                  fill={n.data.color}
                  onMouseEnter={(e) =>
                    n.data.target && onHover(n.data.target, e.currentTarget.getBoundingClientRect())
                  }
                  onMouseLeave={() => onHover(null, null)}
                  onClick={(e) =>
                    n.data.target && onPin(n.data.target, e.currentTarget.getBoundingClientRect())
                  }
                />
                {w > 52 && h > 17 && (
                  <text className="tm-label" x={n.x0 + 4} y={n.y0 + 12}>
                    {n.data.label}
                  </text>
                )}
              </g>
            );
          })}
      </svg>
    </div>
  );
}

function groupFor(groups: readonly SpendGroup[], key: string): SpendGroup | null {
  return groups.find((g) => g.groupId === key) ?? null;
}
