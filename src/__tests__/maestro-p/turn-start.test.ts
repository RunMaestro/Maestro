import { describe, expect, it } from 'vitest';

import { isPreTurnRow, isRowFromBeforeRun, rowTimestampMs } from '../../maestro-p/turn-start';

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
