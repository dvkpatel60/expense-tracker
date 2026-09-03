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
  height = 132,
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
  const pad = { top: 8, bottom: 18 };
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

  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Cumulative spending. Cash out reached ${(last.cash / 100).toFixed(2)} dollars, your share ${(last.mine / 100).toFixed(2)} dollars.`}
      >
        {hasGap && <path d={band(points) ?? ""} fill="var(--sand)" />}
        <path
          d={stroke(points) ?? ""}
          fill="none"
          stroke="var(--ink)"
          strokeWidth={2}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {hasGap && (
          <path
            d={mineStroke(points) ?? ""}
            fill="none"
            stroke="var(--sand-deep)"
            strokeWidth={2}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
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

/** Proportion bar used in the category breakdown. Solid is your share, the
 *  sand remainder is what other people covered. */
export function ProportionBar({ share, cash }: { share: Cents; cash: Cents }) {
  const pct = cash === 0 ? 0 : Math.max(0, Math.min(100, (share / cash) * 100));
  return (
    <div className="bar" aria-hidden="true">
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}
