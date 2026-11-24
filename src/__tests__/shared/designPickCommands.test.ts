import { describe, it, expect } from 'vitest';
import {
	normalizeDesignPickCommandResult,
	parseDesignPickCommandRequest,
	type DesignPickSummary,
} from '../../shared/designPickCommands';

const chip: DesignPickSummary = {
	id: 'pick-1',
	kind: 'element',
	label: 'button.cta "Sign up"',
	url: 'https://example.com',
	note: 'bigger',
	text: 'BLOCK',
	screenshot: true,
};

describe('parseDesignPickCommandRequest', () => {
	it('requires a known action and an agent', () => {
		expect(parseDesignPickCommandRequest({ action: 'nope', sessionId: 'a' })).toEqual({
			ok: false,
			error: 'Invalid or missing Design Mode chip action. Must be one of: list, note, remove',
		});
		expect(parseDesignPickCommandRequest({ sessionId: 'a' }).ok).toBe(false);
		expect(parseDesignPickCommandRequest({ action: 'list' })).toEqual({
			ok: false,
			error: 'browser-picks list requires an agent',
		});
		expect(parseDesignPickCommandRequest({ action: 'list', sessionId: '  ' }).ok).toBe(false);
	});

	it('reads a list, trimming the agent and dropping anything a list does not carry', () => {
		expect(
			parseDesignPickCommandRequest({ action: 'list', sessionId: ' agent-1 ', pickId: 'x' })
		).toEqual({ ok: true, request: { action: 'list', sessionId: 'agent-1' } });
	});

	it('reads a remove, which needs a chip id', () => {
		expect(
			parseDesignPickCommandRequest({ action: 'remove', sessionId: 'agent-1', pickId: ' pick-1 ' })
		).toEqual({ ok: true, request: { action: 'remove', sessionId: 'agent-1', pickId: 'pick-1' } });
		for (const pickId of [undefined, '', '   ', 42]) {
			expect(
				parseDesignPickCommandRequest({ action: 'remove', sessionId: 'agent-1', pickId })
			).toEqual({ ok: false, error: 'browser-picks remove requires a chip id' });
		}
	});

	it('reads a note, which needs a chip id and the note text', () => {
		expect(
			parseDesignPickCommandRequest({
				action: 'note',
				sessionId: 'agent-1',
				pickId: ' pick-1 ',
				note: 'Make it blue',
			})
		).toEqual({
			ok: true,
			request: { action: 'note', sessionId: 'agent-1', pickId: 'pick-1', note: 'Make it blue' },
		});
		// An empty note is a real value: it clears the note.
		expect(
			parseDesignPickCommandRequest({ action: 'note', sessionId: 'agent-1', pickId: 'p', note: '' })
		).toMatchObject({ ok: true, request: { note: '' } });
		expect(
			parseDesignPickCommandRequest({ action: 'note', sessionId: 'agent-1', note: 'x' })
		).toEqual({ ok: false, error: 'browser-picks note requires a chip id' });
		for (const note of [undefined, 42, null]) {
			expect(
				parseDesignPickCommandRequest({ action: 'note', sessionId: 'agent-1', pickId: 'p', note })
			).toEqual({
				ok: false,
				error: 'browser-picks note requires the note text (empty clears it)',
			});
		}
	});
});

describe('normalizeDesignPickCommandResult', () => {
	it('keeps the fields of a successful list or remove', () => {
		expect(
			normalizeDesignPickCommandResult({ success: true, aiTabId: 'ai-1', picks: [chip] })
		).toEqual({ success: true, aiTabId: 'ai-1', picks: [chip] });
		expect(
			normalizeDesignPickCommandResult({ success: true, aiTabId: 'ai-1', removed: chip })
		).toEqual({ success: true, aiTabId: 'ai-1', removed: chip });
		expect(
			normalizeDesignPickCommandResult({ success: true, aiTabId: 'ai-1', edited: chip })
		).toEqual({ success: true, aiTabId: 'ai-1', edited: chip });
	});

	it('fails a list with an entry that is not a chip', () => {
		expect(
			normalizeDesignPickCommandResult({ success: true, aiTabId: 'ai-1', picks: [chip, null] })
		).toEqual({
			success: false,
			error: 'Invalid Design Mode chip in the response',
			aiTabId: 'ai-1',
		});
		expect(normalizeDesignPickCommandResult({ success: true, picks: ['x'] })).toMatchObject({
			success: false,
		});
	});

	it('drops fields of the wrong shape', () => {
		expect(
			normalizeDesignPickCommandResult({
				success: true,
				aiTabId: 7,
				picks: 'not a list',
				removed: 'not a chip',
				edited: 'not a chip',
				extra: 'ignored',
			})
		).toEqual({ success: true });
	});

	it('turns a malformed or failed answer into a failure the CLI reports', () => {
		expect(normalizeDesignPickCommandResult(undefined)).toEqual({
			success: false,
			error: 'Invalid Design Mode chip response',
		});
		expect(normalizeDesignPickCommandResult('ok')).toEqual({
			success: false,
			error: 'Invalid Design Mode chip response',
		});
		// No `success: true`, so not a success, whatever else it carries.
		expect(normalizeDesignPickCommandResult({ picks: [chip] })).toEqual({
			success: false,
			error: 'Design Mode chip command failed',
		});
		expect(
			normalizeDesignPickCommandResult({ success: false, error: 'No chip x', aiTabId: 'ai-1' })
		).toEqual({ success: false, error: 'No chip x', aiTabId: 'ai-1' });
	});
});
