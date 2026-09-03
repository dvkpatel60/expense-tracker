import { useMemo } from "react";
import { scaleUtc, scaleLinear } from "d3-scale";
import { area, line, curveMonotoneX } from "d3-shape";
import type { Cents } from "../../core/money.js";
import { effectiveAmount } from "../../core/split.js";
import type { Claim, Transaction } from "../../core/types.js";

interface Point {
  t: number;
  cash: number;
  mine: number;
}

/**
 * Cumulative spend across the period, cash out against your share. The gap
 * between the two lines is the whole point of the product, so it is drawn as
 * a filled band rather than left for the reader to infer from two totals.
 *
 * SVG, not canvas or WebGL: the values stay selectable, the axis labels stay
 * real text, and it scales to any width without a redraw.
 */
export function SpendChart({
  transactions,
  claims,
  height = 190,
}: {
  transactions: readonly Transaction[];
  claims: readonly Claim[];
  height?: number;
}) {
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
    if (first) out.unshift({ t: first.t - 86_400_000, cash: 0, mine: 0 });
    return out;
  }, [transactions, claims]);

  if (points.length < 2) return null;

  const width = 700;
  const pad = { top: 14, bottom: 24 };
  const inner = height - pad.top - pad.bottom;

  const x = scaleUtc()
    .domain([points[0]!.t, points[points.length - 1]!.t])
    .range([0, width]);
  const y = scaleLinear()
    .domain([0, Math.max(...points.map((p) => p.cash)) || 1])
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

  const last = points[points.length - 1]!;
  const hasGap = last.cash - last.mine > 0;
  const ticks = y.ticks(3);
  const money = (c: number): string =>
    c >= 100_000 ? `$${Math.round(c / 100_000)}k` : `$${Math.round(c / 100)}`;
  const dayLabel = (t: number): string =>
    new Date(t).toLocaleDateString("en-CA", { day: "numeric", month: "short", timeZone: "UTC" });

  return (
    <div className="chart">
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
        {/* The endpoint is the figure the KPI above states, so it is marked. */}
        <circle cx={x(last.t)} cy={y(last.cash)} r={4} fill="var(--accent-ink)" />
        <text
          x={0}
          y={height - 4}
          fill="var(--ink-3)"
          fontSize={11}
        >
          {dayLabel(points[0]!.t)}
        </text>
        <text
          x={width}
          y={height - 4}
          fill="var(--ink-3)"
          fontSize={11}
          textAnchor="end"
        >
          {dayLabel(last.t)}
        </text>
      </svg>
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
