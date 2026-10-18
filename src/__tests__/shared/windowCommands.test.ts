import { describe, it, expect } from 'vitest';
import {
	normalizeWindowCommandResult,
	parseWindowCommandRequest,
} from '../../shared/windowCommands';

describe('parseWindowCommandRequest', () => {
	it('accepts list with nothing else', () => {
		expect(parseWindowCommandRequest({ action: 'list', targetId: 'ignored' })).toEqual({
			ok: true,
			request: { action: 'list' },
		});
	});

	it('requires a target and a destination for moves', () => {
		expect(parseWindowCommandRequest({ action: 'move-group', to: 'new' })).toEqual({
			ok: false,
			error: 'window move-group requires a group id',
		});
		expect(parseWindowCommandRequest({ action: 'move-agent', targetId: 'a' })).toEqual({
			ok: false,
			error: 'window move-agent requires a destination (--to)',
		});
		expect(parseWindowCommandRequest({ action: 'move-agent', targetId: ' a ', to: ' 2 ' })).toEqual(
			{ ok: true, request: { action: 'move-agent', targetId: 'a', to: '2' } }
		);
	});

	it('rejects an unknown action', () => {
		const parsed = parseWindowCommandRequest({ action: 'teleport' });
		expect(parsed.ok).toBe(false);
	});
});

describe('normalizeWindowCommandResult', () => {
	it('turns a malformed reply into a failure', () => {
		expect(normalizeWindowCommandResult(null).success).toBe(false);
		expect(normalizeWindowCommandResult({ success: 'yes' })).toEqual({
			success: false,
			error: 'Window command failed',
		});
	});

	it('keeps the known fields of a success', () => {
		expect(
			normalizeWindowCommandResult({
				success: true,
				windowId: 'w',
				windowLabel: 'Window 2',
				movedAgentIds: ['a'],
				junk: 1,
			})
		).toEqual({ success: true, windowId: 'w', windowLabel: 'Window 2', movedAgentIds: ['a'] });
	});
});
