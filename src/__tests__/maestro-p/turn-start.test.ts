import { describe, expect, it } from 'vitest';

import { isPreTurnRow } from '../../maestro-p/turn-start';

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
