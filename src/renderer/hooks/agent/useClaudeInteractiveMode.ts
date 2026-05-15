/**
 * useClaudeInteractiveMode — per-tab manual Claude headless-mode toggle.
 *
 * Backs the AI tab overlay menu's three-state cycle:
 *   auto → force interactive → force API → back to auto.
 *
 * - `auto` defers to the global `claudeCode.headlessMode` setting and the
 *   spawner's auto-resolver (limit-aware fallback).
 * - `force-interactive` pins the next spawn to maestro-p driving the Claude
 *   TUI, preserving Max-plan quota.
 * - `force-api` pins the next spawn to `claude --print` (billed via API).
 *
 * Persists state through `agents:setClaudeInteractiveMode` and kills every
 * AI tab process on the session so the next user message naturally respawns
 * under the new mode. The renderer never eagerly respawns — Claude's API mode
 * is single-turn per spawn anyway, so an idle respawn would be a no-op.
 */

import { useCallback } from 'react';
import { useSessionStore, selectSessionById } from '../../stores/sessionStore';
import { logger } from '../../utils/logger';
import type { Session } from '../../types';

/** Canonical cycle order — exported so tests + UI label rendering share one source of truth. */
export const CLAUDE_MODE_CYCLE_ORDER = ['auto', 'force-interactive', 'force-api'] as const;

export type ClaudeModeCyclePosition = (typeof CLAUDE_MODE_CYCLE_ORDER)[number];

type ClaudeInteractive = NonNullable<Session['claudeInteractive']>;

/**
 * Map a persisted `claudeInteractive` block onto its UI cycle position.
 *
 * The `'limit'` reason collapses to `'auto'` in the UI because it's
 * selector-driven (auto-fallback after hitting a quota wall), not a manual
 * pin — the user never sees a distinct "force limit" state.
 */
export function cycleFromInteractive(
	block: ClaudeInteractive | undefined
): ClaudeModeCyclePosition {
	if (!block) return 'auto';
	if (block.modeReason !== 'user') return 'auto';
	return block.mode === 'interactive' ? 'force-interactive' : 'force-api';
}

/** Advance one step in the canonical cycle, wrapping around to `auto`. */
export function nextClaudeModeCycle(current: ClaudeModeCyclePosition): ClaudeModeCyclePosition {
	const idx = CLAUDE_MODE_CYCLE_ORDER.indexOf(current);
	const nextIdx = (idx + 1) % CLAUDE_MODE_CYCLE_ORDER.length;
	return CLAUDE_MODE_CYCLE_ORDER[nextIdx];
}

/** Project a cycle position back onto the `(mode, modeReason)` pair to persist. */
function persistShapeFor(
	position: ClaudeModeCyclePosition,
	priorMode: 'interactive' | 'api' | undefined
): { mode: 'interactive' | 'api'; modeReason: 'user' | 'auto' } {
	if (position === 'force-interactive') return { mode: 'interactive', modeReason: 'user' };
	if (position === 'force-api') return { mode: 'api', modeReason: 'user' };
	// auto: preserve the prior `mode` value so the persisted block doesn't churn
	// gratuitously — the selector ignores `mode` when `modeReason !== 'user'`.
	return { mode: priorMode ?? 'api', modeReason: 'auto' };
}

export interface UseClaudeInteractiveModeResult {
	/** Current UI cycle position. `auto` for non-Claude tabs and missing sessions. */
	mode: ClaudeModeCyclePosition;
	/** Whether the session is a Claude Code tab (used to gate the menu item entry). */
	isClaudeCode: boolean;
	/** Set the mode to a specific cycle position. */
	setMode: (position: ClaudeModeCyclePosition) => Promise<void>;
	/** Advance one step in the cycle. */
	cycle: () => Promise<void>;
}

/**
 * Tolerant hook: returns `mode: 'auto'`, `isClaudeCode: false`, and a no-op
 * `setMode` when the session is missing or isn't a Claude Code tab. Keeps the
 * call site in MainPanel un-guarded.
 */
export function useClaudeInteractiveMode(
	sessionId: string | undefined
): UseClaudeInteractiveModeResult {
	const session = useSessionStore(sessionId ? selectSessionById(sessionId) : () => undefined);

	const isClaudeCode = session?.toolType === 'claude-code';
	const mode: ClaudeModeCyclePosition = isClaudeCode
		? cycleFromInteractive(session?.claudeInteractive)
		: 'auto';

	const setMode = useCallback(
		async (position: ClaudeModeCyclePosition) => {
			if (!sessionId || !isClaudeCode || !session) return;

			const current = cycleFromInteractive(session.claudeInteractive);
			if (current === position) return;

			const { mode: nextMode, modeReason } = persistShapeFor(
				position,
				session.claudeInteractive?.mode
			);

			try {
				await window.maestro.agents.setClaudeInteractiveMode(sessionId, nextMode, modeReason);
			} catch (err) {
				logger.error('[useClaudeInteractiveMode] Failed to persist mode change', undefined, err);
				return;
			}

			// Kill every AI tab process on this session so a stale-mode turn can't
			// keep streaming. The next user message respawns the tab via
			// agentStore.processQueuedItem → window.maestro.process.spawn, which
			// resolves the mode fresh via the spawner's selectMode() block.
			const tabs = session.aiTabs ?? [];
			const killPromises: Promise<unknown>[] = [];
			// Legacy single-AI session (no aiTabs array) uses the `<sessionId>-ai` shape.
			if (tabs.length === 0) {
				killPromises.push(window.maestro.process.kill(`${sessionId}-ai`).catch(() => undefined));
			} else {
				for (const tab of tabs) {
					killPromises.push(
						window.maestro.process.kill(`${sessionId}-ai-${tab.id}`).catch(() => undefined)
					);
				}
			}
			await Promise.allSettled(killPromises);
		},
		[sessionId, isClaudeCode, session]
	);

	const cycle = useCallback(() => setMode(nextClaudeModeCycle(mode)), [mode, setMode]);

	return { mode, isClaudeCode, setMode, cycle };
}
