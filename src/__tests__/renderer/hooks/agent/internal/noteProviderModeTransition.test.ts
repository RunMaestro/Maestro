/**
 * Unit tests for the per-provider Dynamic-switch dedup
 * (`noteProviderModeTransition`).
 *
 * The TUI↔API switch is decided per Anthropic account (`configDirKey`), shared
 * by every agent on that account. The helper ensures a switch is announced
 * exactly once per account-wide transition: the first agent to observe a new
 * mode announces it; every other agent on the same account cascades silently.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	noteProviderModeTransition,
	__resetAnnouncedProviderMode,
} from '../../../../../renderer/hooks/agent/internal/useAgentClaudeModeResolvedListener';

describe('noteProviderModeTransition', () => {
	beforeEach(() => {
		__resetAnnouncedProviderMode();
	});

	it('baselines the first observation per provider without announcing', () => {
		expect(noteProviderModeTransition('/Users/me/.claude', 'interactive')).toEqual({
			transitioned: false,
		});
	});

	it('does not announce when the mode is unchanged (the cascade: other agents follow silently)', () => {
		noteProviderModeTransition('/Users/me/.claude', 'interactive'); // baseline
		// Three more agents on the same account resolve the same mode.
		expect(noteProviderModeTransition('/Users/me/.claude', 'interactive').transitioned).toBe(false);
		expect(noteProviderModeTransition('/Users/me/.claude', 'interactive').transitioned).toBe(false);
		expect(noteProviderModeTransition('/Users/me/.claude', 'interactive').transitioned).toBe(false);
	});

	it('announces exactly once on a real account-wide transition, then cascades silently', () => {
		noteProviderModeTransition('/Users/me/.claude', 'interactive'); // baseline

		// First agent to hit the limit flips the account to API → announce once.
		expect(noteProviderModeTransition('/Users/me/.claude', 'api')).toEqual({
			transitioned: true,
			prevMode: 'interactive',
		});
		// Every other agent on the same account that resolves API after the flip
		// must NOT re-announce.
		expect(noteProviderModeTransition('/Users/me/.claude', 'api').transitioned).toBe(false);
		expect(noteProviderModeTransition('/Users/me/.claude', 'api').transitioned).toBe(false);
	});

	it('announces the switch back to Time Limits once when the quota window resets', () => {
		noteProviderModeTransition('/Users/me/.claude', 'api'); // baseline (account already limited)

		expect(noteProviderModeTransition('/Users/me/.claude', 'interactive')).toEqual({
			transitioned: true,
			prevMode: 'api',
		});
		expect(noteProviderModeTransition('/Users/me/.claude', 'interactive').transitioned).toBe(false);
	});

	it('tracks each provider (account) independently', () => {
		noteProviderModeTransition('/Users/me/.claude', 'interactive'); // baseline A
		noteProviderModeTransition('/Users/me/.claude-work', 'interactive'); // baseline B

		// Account A flips; account B is untouched.
		expect(noteProviderModeTransition('/Users/me/.claude', 'api').transitioned).toBe(true);
		expect(noteProviderModeTransition('/Users/me/.claude-work', 'interactive').transitioned).toBe(
			false
		);
		// Account B's own later flip announces on its own schedule.
		expect(noteProviderModeTransition('/Users/me/.claude-work', 'api').transitioned).toBe(true);
	});
});
