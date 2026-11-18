import { describe, it, expect } from 'vitest';
import {
	normalizeMessagePinCommandResult,
	parseMessagePinCommandRequest,
} from '../../shared/messagePinCommands';

const base = { sessionId: 'agent-1', tabId: 'tab-1' };

describe('parseMessagePinCommandRequest', () => {
	it('refuses an unknown action', () => {
		const parsed = parseMessagePinCommandRequest({ ...base, action: 'pin' });
		expect(parsed.ok).toBe(false);
	});

	it('requires an agent and a tab', () => {
		expect(parseMessagePinCommandRequest({ action: 'list', tabId: 't' }).ok).toBe(false);
		expect(parseMessagePinCommandRequest({ action: 'list', sessionId: 's' }).ok).toBe(false);
	});

	it('accepts list and show with only the tab', () => {
		expect(parseMessagePinCommandRequest({ ...base, action: 'list' })).toEqual({
			ok: true,
			request: { action: 'list', ...base },
		});
		expect(parseMessagePinCommandRequest({ ...base, action: 'show' }).ok).toBe(true);
	});

	it('needs exactly one of a message id or --last for add', () => {
		expect(parseMessagePinCommandRequest({ ...base, action: 'add' }).ok).toBe(false);
		expect(
			parseMessagePinCommandRequest({ ...base, action: 'add', messageId: 'm', last: 'agent' }).ok
		).toBe(false);
		expect(parseMessagePinCommandRequest({ ...base, action: 'add', last: 'tool' }).ok).toBe(false);
		expect(parseMessagePinCommandRequest({ ...base, action: 'add', last: 'agent' })).toEqual({
			ok: true,
			request: { action: 'add', ...base, last: 'agent' },
		});
		expect(parseMessagePinCommandRequest({ ...base, action: 'add', messageId: ' m1 ' })).toEqual({
			ok: true,
			request: { action: 'add', ...base, messageId: 'm1' },
		});
	});

	it('needs a pin id for remove and rename, and a string label', () => {
		expect(parseMessagePinCommandRequest({ ...base, action: 'remove' }).ok).toBe(false);
		expect(parseMessagePinCommandRequest({ ...base, action: 'remove', pinId: 'p' }).ok).toBe(true);
		expect(
			parseMessagePinCommandRequest({ ...base, action: 'rename', pinId: 'p', label: 5 }).ok
		).toBe(false);
		expect(parseMessagePinCommandRequest({ ...base, action: 'rename', pinId: 'p' })).toEqual({
			ok: true,
			request: { action: 'rename', ...base, pinId: 'p', label: '' },
		});
	});
});

describe('normalizeMessagePinCommandResult', () => {
	it('turns a malformed answer into a failure', () => {
		expect(normalizeMessagePinCommandResult(null).success).toBe(false);
		expect(normalizeMessagePinCommandResult({ pins: [] }).success).toBe(false);
	});

	it('keeps the known fields of a success', () => {
		expect(
			normalizeMessagePinCommandResult({ success: true, pins: [], alreadyPinned: true, junk: 1 })
		).toEqual({ success: true, pins: [], alreadyPinned: true });
	});
});
