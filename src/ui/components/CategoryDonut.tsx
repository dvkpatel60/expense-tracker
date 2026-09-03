import { useMemo } from "react";
import { arc, pie } from "d3-shape";
import type { SpendCategory, SpendGroup } from "../../core/ledger.js";
import { cents } from "../../core/money.js";
import type { Cents } from "../../core/money.js";
import { categoryColor, dollarsAbs, groupColor } from "../format.js";

interface Slice {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly color: string;
}

/**
 * Spending by group, or by category inside one group once drilled in.
 *
 * A ring rather than a pie: the hole is where the period total goes, which is
 * the figure people actually want, and it removes the thin centre wedges that
 * make small slices unreadable. Twenty-one categories would be unreadable at
 * either radius, which is why this is fed groups (core/categorize.ts) and
 * drills down rather than showing everything at once.
 *
 * aria-hidden by design: the ranked list beside it is the same data as text,
 * so a screen reader gets the table and not a pile of unlabelled paths.
 */
export function CategoryDonut({
  groups,
  drilled,
  onDrill,
  size = 220,
}: {
  groups: readonly SpendGroup[];
  /** When set, the ring shows this group's categories instead of the groups. */
  drilled: SpendGroup | null;
  onDrill(group: SpendGroup | null): void;
  size?: number;
}) {
  const slices = useMemo<Slice[]>(() => {
    if (drilled) {
      return drilled.categories
        .filter((c: SpendCategory) => c.yourShare > 0)
        .map((c) => ({
          key: c.categoryId,
          label: c.categoryId,
          value: c.yourShare,
          color: categoryColor(c.categoryId),
        }));
    }
    return groups
      .filter((g) => g.yourShare > 0)
      .map((g) => ({
        key: g.groupId,
        label: g.groupId,
        value: g.yourShare,
        color: groupColor(g.groupId),
      }));
  }, [groups, drilled]);

  const total = slices.reduce((n, s) => n + s.value, 0);
  if (slices.length === 0 || total === 0) return null;

  const radius = size / 2;
  const layout = pie<Slice>()
    .value((s) => s.value)
    .sort(null)
    .padAngle(0.012);
  const shape = arc<{ startAngle: number; endAngle: number }>()
    .innerRadius(radius * 0.62)
    .outerRadius(radius)
    .cornerRadius(2);

  const arcs = layout(slices as Slice[]);
  const count = drilled ? drilled.transactionCount : groups.reduce((n, g) => n + g.transactionCount, 0);

  return (
    <div className="donut-wrap">
      <div className="donut" style={{ width: size, height: size }}>
        <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
          <g transform={`translate(${radius}, ${radius})`}>
            {arcs.map((a) => (
              <path
                key={a.data.key}
                d={shape(a) ?? ""}
                fill={a.data.color}
                className="donut-slice"
                onClick={() => !drilled && onDrill(groupFor(groups, a.data.key))}
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

      <ul className="donut-key">
        {drilled && (
          <li>
            <button className="donut-back" onClick={() => onDrill(null)}>
              &larr; All groups
            </button>
          </li>
        )}
        {slices.map((s) => (
          <li key={s.key}>
            <button
              className="donut-key-row"
              disabled={Boolean(drilled)}
              onClick={() => onDrill(groupFor(groups, s.key))}
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

function groupFor(groups: readonly SpendGroup[], key: string): SpendGroup | null {
  return groups.find((g) => g.groupId === key) ?? null;
}
