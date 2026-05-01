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
 *   2. Match the key against any session's `toolType` — if a session of that
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
 * Clamp an absolute tooltip position so its bounding rect stays inside the
 * viewport. Pass `transform` to describe which corner of the tooltip the
 * anchor point represents — the function returns top-left coordinates the
 * caller can drop directly into `style.left` / `style.top` (and stop using
 * a CSS transform).
 *
 * **Why:** anchoring a tooltip at the right edge of a chart with
 * `transform: translate(-50%, -100%)` lets the tooltip extend off-screen.
 * `clampTooltipToViewport` keeps the rect inside the viewport.
 */
export function clampTooltipToViewport(args: {
	anchorX: number;
	anchorY: number;
	width: number;
	height: number;
	transform?: 'top-center' | 'bottom-center' | 'top-left' | 'left-center';
	margin?: number;
}): { left: number; top: number } {
	const { anchorX, anchorY, width, height, transform = 'top-left', margin = 8 } = args;

	let left: number;
	let top: number;
	switch (transform) {
		case 'top-center':
			left = anchorX - width / 2;
			top = anchorY - height;
			break;
		case 'bottom-center':
			left = anchorX - width / 2;
			top = anchorY;
			break;
		case 'left-center':
			left = anchorX;
			top = anchorY - height / 2;
			break;
		case 'top-left':
		default:
			left = anchorX;
			top = anchorY;
			break;
	}

	const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 0;
	const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 0;

	if (viewportWidth > 0) {
		left = Math.max(margin, Math.min(left, viewportWidth - width - margin));
	}
	if (viewportHeight > 0) {
		top = Math.max(margin, Math.min(top, viewportHeight - height - margin));
	}

	return { left, top };
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
