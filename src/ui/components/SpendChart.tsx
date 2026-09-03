import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { scaleUtc, scaleLinear } from "d3-scale";
import { area, line, curveMonotoneX } from "d3-shape";
import { cents } from "../../core/money.js";
import type { Cents } from "../../core/money.js";
import { effectiveAmount } from "../../core/split.js";
import type { Claim, Transaction } from "../../core/types.js";
import { dollarsAbs } from "../format.js";

interface Point {
  t: number;
  cash: number;
  mine: number;
}

const DAY = 86_400_000;

/**
 * Cumulative spend across the period, cash out against your share. The gap
 * between the two lines is the whole point of the product, so it is drawn as
 * a filled band rather than left for the reader to infer from two totals.
 *
 * SVG, not canvas or WebGL: the values stay selectable, the axis labels stay
 * real text, and it scales to any width without a redraw.
 *
 * The width is measured rather than fixed at 700. A hard width made the chart
 * the only element on the Overview panel that did not agree with the ring and
 * the treemap beside it, and it stretched on wide screens through the viewBox
 * instead of drawing more chart.
 */
export function SpendChart({
  transactions,
  claims,
  velocity,
  height = 190,
}: {
  transactions: readonly Transaction[];
  claims: readonly Claim[];
  /** Average spend per calendar day, from core. Drawn as the constant-rate
   *  trajectory, which is what "am I ahead of my average" actually asks. */
  velocity?: Cents;
  height?: number;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(700);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = (): void => setWidth(Math.max(240, el.clientWidth || 700));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const points = useMemo<Point[]>(() => {
    const sorted = [...transactions].sort((a, b) => (a.date < b.date ? -1 : 1));
    let cash = 0;
    let mine = 0;
    const byDay = new Map<number, Point>();
    for (const tx of sorted) {
      cash += -tx.amount;
      mine += -effectiveAmount(tx, claims);
      const t = Date.parse(tx.date + "T00:00:00Z");
      byDay.set(t, { t, cash, mine });
    }
    const out = [...byDay.values()];
    const first = out[0];
    if (first) out.unshift({ t: first.t - DAY, cash: 0, mine: 0 });
    return out;
  }, [transactions, claims]);

  if (points.length < 2) return <div className="chart" ref={wrap} />;

  const pad = { top: 14, bottom: 24 };
  const inner = height - pad.top - pad.bottom;
  const first = points[0]!;
  const last = points[points.length - 1]!;

  // The constant-rate trajectory over the same span the chart draws. It is not
  // the chord from start to end: velocity is per *calendar* day of the period,
  // so a month where spending stopped on the 20th shows the reference running
  // on past the flat tail, which is the point.
  const days = (last.t - first.t) / DAY;
  const paceEnd = velocity && velocity > 0 ? velocity * days : 0;

  const x = scaleUtc().domain([first.t, last.t]).range([0, width]);
  const y = scaleLinear()
    .domain([0, Math.max(...points.map((p) => p.cash), paceEnd) || 1])
    .nice()
    .range([pad.top + inner, pad.top]);

  const band = area<Point>()
    .x((p) => x(p.t))
    .y0((p) => y(p.mine))
    .y1((p) => y(p.cash))
    .curve(curveMonotoneX);

  const stroke = line<Point>()
    .x((p) => x(p.t))
    .y((p) => y(p.cash))
    .curve(curveMonotoneX);

  const mineStroke = line<Point>()
    .x((p) => x(p.t))
    .y((p) => y(p.mine))
    .curve(curveMonotoneX);

  const hasGap = last.cash - last.mine > 0;
  const ticks = y.ticks(3);
  const money = (c: number): string =>
    c >= 100_000 ? `$${Math.round(c / 100_000)}k` : `$${Math.round(c / 100)}`;
  const dayLabel = (t: number): string =>
    new Date(t).toLocaleDateString("en-CA", { day: "numeric", month: "short", timeZone: "UTC" });

  // Nearest point by x, because a cumulative series is a step function between
  // days and interpolating a reading between two of them would invent a total.
  const onMove = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const px = ((e.clientX - rect.left) / rect.width) * width;
    let best = 0;
    let bestDist = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(x(p.t) - px);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    setHover(best);
  };

  const cursor = hover === null ? null : (points[hover] ?? null);
  const cursorPace = cursor && paceEnd > 0 ? ((cursor.t - first.t) / DAY) * (velocity ?? 0) : 0;
  const tipLeft = cursor ? Math.max(0, Math.min(width - 168, x(cursor.t) - 84)) : 0;

  return (
    <div
      className="chart"
      ref={wrap}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Cumulative spending. Cash out reached ${(last.cash / 100).toFixed(2)} dollars, your share ${(last.mine / 100).toFixed(2)} dollars.`}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={0}
              x2={width}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--line)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={0}
              y={y(v) - 4}
              fill="var(--ink-3)"
              fontSize={11}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {money(v)}
            </text>
          </g>
        ))}
        {hasGap && <path d={band(points) ?? ""} fill="var(--shared)" />}
        {paceEnd > 0 && (
          <line
            className="chart-pace"
            x1={x(first.t)}
            y1={y(0)}
            x2={x(last.t)}
            y2={y(paceEnd)}
            stroke="var(--ink-3)"
            strokeWidth={1}
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <path
          d={stroke(points) ?? ""}
          fill="none"
          stroke="var(--accent-ink)"
          strokeWidth={2}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {hasGap && (
          <path
            d={mineStroke(points) ?? ""}
            fill="none"
            stroke="var(--ink-3)"
            strokeWidth={2}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {cursor && (
          <g className="chart-cursor">
            <line
              x1={x(cursor.t)}
              x2={x(cursor.t)}
              y1={pad.top}
              y2={pad.top + inner}
              stroke="var(--line-2)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={x(cursor.t)} cy={y(cursor.cash)} r={3.5} fill="var(--accent-ink)" />
            {hasGap && <circle cx={x(cursor.t)} cy={y(cursor.mine)} r={3.5} fill="var(--ink-3)" />}
          </g>
        )}
        {/* The endpoint is the figure the KPI above states, so it is marked. */}
        <circle cx={x(last.t)} cy={y(last.cash)} r={4} fill="var(--accent-ink)" />
        <text x={0} y={height - 4} fill="var(--ink-3)" fontSize={11}>
          {dayLabel(first.t)}
        </text>
        <text x={width} y={height - 4} fill="var(--ink-3)" fontSize={11} textAnchor="end">
          {dayLabel(last.t)}
        </text>
      </svg>

      {cursor && (
        <div className="chart-tip" style={{ left: tipLeft }}>
          <div className="chart-tip-day">{dayLabel(cursor.t)}</div>
          <dl>
            <dt>Cash out</dt>
            <dd className="num">{dollarsAbs(cents(cursor.cash))}</dd>
            <dt>Your share</dt>
            <dd className="num">{dollarsAbs(cents(cursor.mine))}</dd>
            {cursor.cash - cursor.mine > 0 && (
              <>
                <dt>Recovered</dt>
                <dd className="num recovered">{dollarsAbs(cents(cursor.cash - cursor.mine))}</dd>
              </>
            )}
            {cursorPace > 0 && (
              <>
                <dt>Vs average</dt>
                <dd className={cursor.cash > cursorPace ? "num delta-up" : "num delta-down"}>
                  {cursor.cash > cursorPace ? "+" : "-"}
                  {dollarsAbs(cents(Math.abs(cursor.cash - cursorPace)))}
                </dd>
              </>
            )}
          </dl>
        </div>
      )}

      <div className="chart-legend">
        <span>
          <i className="legend-line" />
          Total paid
        </span>
        {hasGap && (
          <span>
            <i className="legend-fill" />
            Other people&rsquo;s
          </span>
        )}
        {paceEnd > 0 && (
          <span>
            <i className="legend-dash" />
            Average pace
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Category bar. Length is the category against the largest one, so the ranking
 * is visible without reading a single figure; the solid part of that length is
 * your share and the remainder is what other people covered. Encoding only the
 * share made every bar full whenever nothing was split, which is a rule, not a
 * chart.
 */
export function ProportionBar({
  share,
  cash,
  max,
  color,
}: {
  share: Cents;
  cash: Cents;
  max: Cents;
  /** The category's own colour, so the bar and the ring agree at a glance. */
  color?: string;
}) {
  const width = max === 0 ? 0 : Math.max(2, Math.min(100, (Math.abs(cash) / Math.abs(max)) * 100));
  const mine = cash === 0 ? 0 : Math.max(0, Math.min(100, (share / cash) * 100));
  return (
    <div className="bar" aria-hidden="true">
      <i style={{ width: `${width}%` }}>
        <b style={{ width: `${mine}%`, ...(color ? { background: color } : {}) }} />
      </i>
    </div>
  );
}
