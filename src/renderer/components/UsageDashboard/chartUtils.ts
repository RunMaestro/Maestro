/**
 * Shared utilities for UsageDashboard chart components.
 *
 * Worktree differentiation helpers let charts visually distinguish
 * worktree child agents from regular agents and parent agents.
 *
 * Name resolution helpers translate raw stats keys (which can be either
 * session IDs or agent type strings like "claude-code") into the user-facing
 * names users assigned to agents in the Left Bar, so charts surface "Backend
 * API" instead of "claude-code".
 */

import type { Session } from '../../types';
import { AGENT_DISPLAY_NAMES } from '../../../shared/agentMetadata';

// `clampTooltipToViewport` was relocated into the shared widget library (so the
// library's ChartTooltip primitive owns its geometry without depending back on
// UsageDashboard). Re-export it here to keep the historical chartUtils API
// stable for any existing importer.
export { clampTooltipToViewport } from '../widgets/output/tooltipGeometry';

/**
 * Returns true if the session is a worktree child (was spawned from a parent agent).
 */
export function isWorktreeAgent(session: Session): boolean {
	return !!session.parentSessionId;
}

/**
 * Returns true if the session is a parent agent that manages worktree children.
 */
export function isParentAgent(session: Session): boolean {
	return !!session.worktreeConfig;
}

/**
 * Resolve a stats `sessionId` (which may include suffixes like tab IDs) to the
 * matching Session. Returns undefined if no match is found.
 *
 * Why the longest-prefix dance: stat keys are either the bare session id or
 * `<id><delimiter><tabId>`. Naive `startsWith` mis-matches when one session id
 * is a prefix of another (e.g. `sess-1` matching keys for `sess-10`), poisoning
 * worktree detection and display-name lookup. We prefer exact match, then a
 * delimited prefix match (`-`, `:`, `/`, `_`, `.`), then fall back to the
 * longest matching id so worktree IDs that violate our delimiter conventions
 * still resolve.
 */
export function findSessionByStatId(
	statSessionId: string,
	sessions: Session[] | undefined
): Session | undefined {
	if (!sessions || sessions.length === 0) return undefined;
	const exact = sessions.find((s) => s.id === statSessionId);
	if (exact) return exact;

	const DELIMITERS = new Set(['-', ':', '/', '_', '.']);
	let best: Session | undefined;
	let bestLen = -1;
	for (const session of sessions) {
		if (!statSessionId.startsWith(session.id)) continue;
		if (statSessionId.length === session.id.length) {
			return session;
		}
		const nextChar = statSessionId.charAt(session.id.length);
		const isDelimited = DELIMITERS.has(nextChar);
		if (isDelimited && session.id.length > bestLen) {
			best = session;
			bestLen = session.id.length;
		}
	}
	if (best) return best;

	// Fallback: longest prefix without a delimiter, so we still resolve when an
	// id was generated outside our delimiter conventions.
	for (const session of sessions) {
		if (!statSessionId.startsWith(session.id)) continue;
		if (session.id.length > bestLen) {
			best = session;
			bestLen = session.id.length;
		}
	}
	return best;
}

/**
 * Convert an agent type string into a human-readable name.
 *
 * For known agent IDs ("claude-code", "factory-droid", etc.) this returns the
 * canonical display name from `AGENT_DISPLAY_NAMES`. For anything else, the
 * key is split on `-` and each segment capitalized so "my-custom-agent"
 * becomes "My Custom Agent".
 */
export function prettifyAgentType(type: string): string {
	if (Object.prototype.hasOwnProperty.call(AGENT_DISPLAY_NAMES, type)) {
		return AGENT_DISPLAY_NAMES[type as keyof typeof AGENT_DISPLAY_NAMES];
	}
	if (!type) return type;
	return type
		.split('-')
		.filter((part) => part.length > 0)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

/**
 * Resolve a single chart-data key (either a session ID or an agent type
 * string) to a display name plus a worktree flag for visual differentiation.
 *
 * Resolution order:
 *   1. Match the key against `Session.id` (with optional suffixes like tab IDs).
 *   2. Match the key against any session's `toolType` - if a session of that
 *      type exists, prefer that session's user-assigned name (single-instance
 *      case) and otherwise fall through to the prettified type.
 *   3. Fall back to `prettifyAgentType(key)`.
 */
export function resolveAgentDisplayName(
	key: string,
	sessions: Session[] | undefined
): { name: string; isWorktree: boolean } {
	const byId = findSessionByStatId(key, sessions);
	if (byId) {
		return {
			name: byId.name || prettifyAgentType(byId.toolType),
			isWorktree: isWorktreeAgent(byId),
		};
	}

	if (sessions && sessions.length > 0) {
		const matchingByType = sessions.filter((s) => s.toolType === key);
		if (matchingByType.length === 1 && matchingByType[0].name) {
			return {
				name: matchingByType[0].name,
				isWorktree: isWorktreeAgent(matchingByType[0]),
			};
		}
		if (matchingByType.length > 0) {
			return { name: prettifyAgentType(key), isWorktree: false };
		}
	}

	return { name: prettifyAgentType(key), isWorktree: false };
}

/**
 * Batch-resolve multiple chart keys to display names, disambiguating any
 * duplicate names by appending ` (2)`, ` (3)`, etc. in input order.
 *
 * The returned map preserves the original keys so callers can look up the
 * resolved name and worktree flag without re-running resolution.
 */
export function buildNameMap(
	keys: string[],
	sessions: Session[] | undefined
): Map<string, { name: string; isWorktree: boolean }> {
	const result = new Map<string, { name: string; isWorktree: boolean }>();
	const nameCounts = new Map<string, number>();

	for (const key of keys) {
		if (result.has(key)) continue;
		const resolved = resolveAgentDisplayName(key, sessions);
		const seen = nameCounts.get(resolved.name) ?? 0;
		const finalName = seen === 0 ? resolved.name : `${resolved.name} (${seen + 1})`;
		nameCounts.set(resolved.name, seen + 1);
		result.set(key, { name: finalName, isWorktree: resolved.isWorktree });
	}

	return result;
}

/**
 * Axis-label budget for a phone-width chart.
 *
 * The default seven labels assume a desktop axis: seven `Aug 20`-sized dates
 * need roughly 300px, and a phone gives a chart about 340px total, so they
 * printed on top of each other and every date read as a smear. Four fit.
 */
export const PHONE_AXIS_LABELS = 4;

/**
 * Pick which x-axis tick indices should carry a label.
 *
 * Every time-series chart on the dashboard wants roughly seven labels and always
 * wants the final one, so the axis ends on the real end date. Naively forcing
 * that last label is what caused overlapping text at the right edge: when the
 * series length isn't a multiple of the interval, the forced label lands one or
 * two slots after the previous one and the two strings collide (e.g. "Jul 25"
 * printed on top of "Jul 26").
 *
 * Here the last label still always wins, but the preceding label is dropped when
 * it would sit closer than a full interval - so labels are never spaced tighter
 * than the interval the chart already deemed readable.
 *
 * @param count - number of ticks on the axis
 * @returns the set of indices to label
 */
export function computeAxisLabelIndices(count: number, maxLabels = 7): Set<number> {
	if (count <= 0) return new Set();

	// Same density heuristic the charts used individually: ~7 labels max.
	// `maxLabels` is how a caller says its axis is narrower than that assumes -
	// seven "Aug 20"-sized labels need about 300px, so on a phone they printed
	// on top of each other and every date read as a four-digit smear.
	const budget = Math.max(2, maxLabels);
	const interval = count > 2 * budget ? Math.ceil(count / budget) : count > budget ? 2 : 1;

	const indices: number[] = [];
	for (let i = 0; i < count; i += interval) indices.push(i);

	const last = count - 1;
	const previous = indices[indices.length - 1];
	if (previous !== last) {
		if (last - previous < interval) indices.pop();
		indices.push(last);
	}

	return new Set(indices);
}

/**
 * Geometry shared by the dashboard's donut charts (Activity Source, Session
 * Location) so they stay visually identical and the center label always has
 * room for its longest value.
 *
 * `centerLabelWidth` is the widest a center label may be drawn: a chord of the
 * hole rather than its full diameter, so a long string ("1,234h 56m") stops
 * before it reaches the ring instead of painting over it.
 */
export const DONUT_CHART = {
	size: 200,
	outerRadius: 88,
	innerRadius: 62,
	/** Extra radius the hovered slice pops out by. */
	hoverExpansion: 4,
	centerLabelWidth: 106,
} as const;

/**
 * SVG arc path generator for donut chart segments.
 *
 * Angles are degrees clockwise from 12 o'clock. A sweep of (near) 360 degrees
 * is drawn as two half arcs, because a single arc whose start and end points
 * coincide renders as nothing.
 */
export function describeDonutArc(
	x: number,
	y: number,
	outerRadius: number,
	innerRadius: number,
	startAngle: number,
	endAngle: number
): string {
	if (endAngle - startAngle >= 359.99) {
		const midAngle = startAngle + 180;
		return `
      ${describeDonutArc(x, y, outerRadius, innerRadius, startAngle, midAngle)}
      ${describeDonutArc(x, y, outerRadius, innerRadius, midAngle, endAngle)}
    `;
	}

	const startRad = (startAngle - 90) * (Math.PI / 180);
	const endRad = (endAngle - 90) * (Math.PI / 180);

	const startOuterX = x + outerRadius * Math.cos(startRad);
	const startOuterY = y + outerRadius * Math.sin(startRad);
	const endOuterX = x + outerRadius * Math.cos(endRad);
	const endOuterY = y + outerRadius * Math.sin(endRad);

	const startInnerX = x + innerRadius * Math.cos(startRad);
	const startInnerY = y + innerRadius * Math.sin(startRad);
	const endInnerX = x + innerRadius * Math.cos(endRad);
	const endInnerY = y + innerRadius * Math.sin(endRad);

	const largeArcFlag = endAngle - startAngle > 180 ? 1 : 0;

	return `
    M ${startOuterX} ${startOuterY}
    A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${endOuterX} ${endOuterY}
    L ${endInnerX} ${endInnerY}
    A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 0 ${startInnerX} ${startInnerY}
    Z
  `;
}
