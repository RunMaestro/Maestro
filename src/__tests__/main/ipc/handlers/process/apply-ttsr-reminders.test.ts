/**
 * Phase 3c: deferred `<system-reminder>` folding at spawn time.
 *
 * The drain itself lives in the TTSR runtime; this covers the spawn-path half -
 * that a queued reminder is prepended to the conversation's next prompt, and
 * that the spawn path is untouched when TTSR has nothing to say (or is off).
 */

import { describe, it, expect, vi } from 'vitest';
import { applyTtsrReminders } from '../../../../../main/ipc/handlers/process/apply-ttsr-reminders';
import type { SpawnProcessConfig } from '../../../../../main/ipc/handlers/process/spawn-types';

const REMINDER =
	'<system-reminder reason="rule_violation" rule="no-console-log" path=".maestro/rules/no-console-log.md">\nUse the project logger.\n</system-reminder>';

function config(overrides: Partial<SpawnProcessConfig> = {}): SpawnProcessConfig {
	return {
		sessionId: 'sess-ai-1',
		toolType: 'claude-code',
		cwd: '/repo',
		command: 'claude',
		args: [],
		prompt: 'Add the login form',
		...overrides,
	} as SpawnProcessConfig;
}

describe('applyTtsrReminders', () => {
	it('prepends queued reminders above the user prompt', () => {
		const take = vi.fn(() => REMINDER);
		const result = applyTtsrReminders(config(), take);

		expect(take).toHaveBeenCalledWith('sess-ai-1');
		expect(result.prompt).toBe(`${REMINDER}\n\nAdd the login form`);
	});

	it('returns the config untouched when nothing is queued', () => {
		const original = config();
		const result = applyTtsrReminders(original, () => '');
		expect(result).toBe(original);
	});

	it('returns the config untouched when TTSR is not wired at all', () => {
		const original = config();
		expect(applyTtsrReminders(original, undefined)).toBe(original);
	});

	it('leaves a promptless spawn alone without draining the queue', () => {
		const take = vi.fn(() => REMINDER);
		const original = config({ prompt: undefined });

		expect(applyTtsrReminders(original, take)).toBe(original);
		// Draining here would silently discard the reminder: a terminal or
		// interactive spawn has no prompt to carry it.
		expect(take).not.toHaveBeenCalled();
	});
});
