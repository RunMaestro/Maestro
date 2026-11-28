import { describe, expect, it } from 'vitest';

import {
	isPreTurnRow,
	isRowFromBeforeRun,
	provesTurnStarted,
	rowTimestampMs,
} from '../../maestro-p/turn-start';

describe('isPreTurnRow', () => {
	it('treats the SessionStart hook result claude logs at resume as pre-turn', () => {
		expect(
			isPreTurnRow({
				type: 'attachment',
				attachment: {
					type: 'hook_success',
					hookName: 'SessionStart:resume',
					hookEvent: 'SessionStart',
					exitCode: 0,
				},
			})
		).toBe(true);
	});

	it('treats the context a SessionStart hook injects as pre-turn', () => {
		expect(
			isPreTurnRow({
				type: 'attachment',
				attachment: {
					type: 'hook_additional_context',
					hookName: 'SessionStart',
					hookEvent: 'SessionStart',
				},
			})
		).toBe(true);
	});

	it('counts the prompt echo and the reply as the turn starting', () => {
		expect(isPreTurnRow({ type: 'user', message: { role: 'user', content: 'hi' } })).toBe(false);
		expect(isPreTurnRow({ type: 'assistant', message: { content: [] } })).toBe(false);
	});

	it('counts attachments from other hooks as the turn starting', () => {
		expect(
			isPreTurnRow({
				type: 'attachment',
				attachment: {
					type: 'hook_success',
					hookName: 'UserPromptSubmit',
					hookEvent: 'UserPromptSubmit',
				},
			})
		).toBe(false);
		expect(
			isPreTurnRow({ type: 'attachment', attachment: { type: 'total_tokens_reminder' } })
		).toBe(false);
	});

	it('rejects values that are not transcript rows', () => {
		expect(isPreTurnRow(null)).toBe(false);
		expect(isPreTurnRow('attachment')).toBe(false);
		expect(isPreTurnRow({ type: 'attachment' })).toBe(false);
	});
});

describe('isRowFromBeforeRun', () => {
	const runStartedAt = Date.parse('2026-11-26T15:40:42.501Z');

	it("treats the previous turn's late-flushed /exit row as stale", () => {
		// The row that failed a resumed turn as prompt_truncated: written by the
		// previous claude two seconds before this run spawned, read after it did.
		const exitRow = {
			type: 'user',
			timestamp: '2026-11-26T15:40:40.334Z',
			message: {
				role: 'user',
				content:
					'<command-name>/exit</command-name>\n            <command-message>exit</command-message>\n            <command-args></command-args>',
			},
		};
		expect(isRowFromBeforeRun(exitRow, runStartedAt)).toBe(true);
	});

	it('keeps rows made at or after the run started', () => {
		const echo = {
			type: 'user',
			timestamp: '2026-11-26T15:40:43.010Z',
			message: { content: 'hi' },
		};
		expect(isRowFromBeforeRun(echo, runStartedAt)).toBe(false);
		expect(
			isRowFromBeforeRun({ type: 'user', timestamp: '2026-11-26T15:40:42.501Z' }, runStartedAt)
		).toBe(false);
	});

	it('does not judge rows without a usable timestamp', () => {
		expect(isRowFromBeforeRun({ type: 'cost-state' }, runStartedAt)).toBe(false);
		expect(isRowFromBeforeRun({ type: 'user', timestamp: 'not a time' }, runStartedAt)).toBe(false);
		expect(isRowFromBeforeRun({ type: 'user', timestamp: 1 }, runStartedAt)).toBe(false);
		expect(isRowFromBeforeRun(null, runStartedAt)).toBe(false);
	});
});

describe('rowTimestampMs', () => {
	it('reads the ISO timestamp claude stamps on a row', () => {
		expect(rowTimestampMs({ timestamp: '2026-11-26T15:40:40.334Z' })).toBe(
			Date.parse('2026-11-26T15:40:40.334Z')
		);
	});

	it('is null for rows claude writes without one', () => {
		expect(rowTimestampMs({ type: 'file-history-snapshot' })).toBeNull();
		expect(rowTimestampMs('row')).toBeNull();
	});
});

describe('provesTurnStarted', () => {
	const runStartedAt = Date.parse('2026-11-27T16:59:11.000Z');

	it('counts the stamped prompt echo and reply made after the run started', () => {
		expect(
			provesTurnStarted(
				{ type: 'user', timestamp: '2026-11-27T16:59:12.000Z', message: { content: 'hi' } },
				runStartedAt
			)
		).toBe(true);
		expect(
			provesTurnStarted(
				{ type: 'assistant', timestamp: '2026-11-27T16:59:11.000Z', message: { content: [] } },
				runStartedAt
			)
		).toBe(true);
	});

	it("ignores a previous claude's all-unstamped exit flush", () => {
		// The block a synopsis claude flushed after the next turn began tailing:
		// none of it is stamped, and its tools-used row once stopped the Enter
		// resubmit loop with the user's prompt still parked in the editor.
		for (const row of [
			{ type: 'cost-state' },
			{ type: 'tools-used' },
			{ type: 'file-history-snapshot' },
			{ type: 'last-prompt', lastPrompt: 'Give a brief synopsis' },
		]) {
			expect(provesTurnStarted(row, runStartedAt)).toBe(false);
		}
	});

	it('ignores stamped rows made before the run started', () => {
		expect(
			provesTurnStarted(
				{ type: 'system', subtype: 'turn_duration', timestamp: '2026-11-27T16:59:10.453Z' },
				runStartedAt
			)
		).toBe(false);
	});

	it('ignores the SessionStart rows claude writes at boot', () => {
		expect(
			provesTurnStarted(
				{
					type: 'attachment',
					timestamp: '2026-11-27T16:59:12.000Z',
					attachment: { type: 'hook_success', hookEvent: 'SessionStart' },
				},
				runStartedAt
			)
		).toBe(false);
	});

	it('counts a stamped non-SessionStart hook row', () => {
		expect(
			provesTurnStarted(
				{
					type: 'attachment',
					timestamp: '2026-11-27T16:59:12.000Z',
					attachment: { type: 'hook_success', hookEvent: 'PreToolUse' },
				},
				runStartedAt
			)
		).toBe(true);
	});

	// The rows a resumed Pedsidian turn tailed while claude was still booting,
	// before its SessionStart hook ran or its prompt was read (2026-11-27).
	it('ignores the unstamped rows a --resume boot tails', () => {
		for (const row of [
			{ type: 'last-prompt', lastPrompt: 'earlier', sessionId: 's' },
			{ type: 'tools-used', tools: ['Bash'], sessionId: 's' },
			{ type: 'file-history-snapshot', messageId: 'm', snapshot: {} },
			{ type: 'mode', mode: 'normal', sessionId: 's' },
			{ type: 'permission-mode', permissionMode: 'default', sessionId: 's' },
		]) {
			expect(provesTurnStarted(row, runStartedAt)).toBe(false);
		}
	});
});
