import { describe, it, expect } from 'vitest';
import { messagesToLogEntries } from '../../../../../renderer/components/AgentSessionsBrowser/utils/messagesToLogEntries';
import type { SessionMessage } from '../../../../../renderer/hooks/agent/useSessionViewer';

function makeMsg(overrides: Partial<SessionMessage> = {}): SessionMessage {
	return {
		type: 'assistant',
		content: 'hello',
		timestamp: '2024-01-01T12:00:00Z',
		uuid: 'uuid-1',
		...overrides,
	};
}

describe('messagesToLogEntries', () => {
	it('returns empty array for empty input', () => {
		expect(messagesToLogEntries([], 'session-1')).toEqual([]);
	});

	it('maps type=user to source=user', () => {
		const result = messagesToLogEntries([makeMsg({ type: 'user', uuid: 'u1' })], 'sid');
		expect(result[0].source).toBe('user');
	});

	it('maps type=assistant to source=stdout', () => {
		const result = messagesToLogEntries([makeMsg({ type: 'assistant', uuid: 'u1' })], 'sid');
		expect(result[0].source).toBe('stdout');
	});

	it('maps any non-user type to source=stdout', () => {
		const result = messagesToLogEntries([makeMsg({ type: 'system', uuid: 'u1' })], 'sid');
		expect(result[0].source).toBe('stdout');
	});

	it('uses [No content] fallback when content is undefined', () => {
		const msg = makeMsg({ uuid: 'u1' });
		// @ts-expect-error testing undefined content
		msg.content = undefined;
		const result = messagesToLogEntries([msg], 'sid');
		expect(result[0].text).toBe('[No content]');
	});

	it('uses [No content] fallback when content is empty string', () => {
		const result = messagesToLogEntries([makeMsg({ content: '', uuid: 'u1' })], 'sid');
		expect(result[0].text).toBe('[No content]');
	});

	it('uses uuid as id when present', () => {
		const result = messagesToLogEntries([makeMsg({ uuid: 'my-uuid' })], 'sid');
		expect(result[0].id).toBe('my-uuid');
	});

	it('uses sessionId-idx as id fallback when uuid is missing', () => {
		const msg = makeMsg();
		// @ts-expect-error testing missing uuid
		msg.uuid = undefined;
		const result = messagesToLogEntries([msg], 'my-session');
		expect(result[0].id).toBe('my-session-0');
	});

	it('converts timestamp string to milliseconds via new Date', () => {
		const ts = '2024-06-15T10:30:00Z';
		const result = messagesToLogEntries([makeMsg({ timestamp: ts, uuid: 'u1' })], 'sid');
		expect(result[0].timestamp).toBe(new Date(ts).getTime());
	});

	it('filters out messages with non-empty toolUse array', () => {
		const messages = [
			makeMsg({ uuid: 'u1', type: 'user', content: 'user msg' }),
			makeMsg({ uuid: 'u2', type: 'assistant', toolUse: [{ name: 'bash' }] }),
			makeMsg({ uuid: 'u3', type: 'assistant', content: 'response' }),
		];
		const result = messagesToLogEntries(messages, 'sid');
		expect(result).toHaveLength(2);
		expect(result.map((r) => r.id)).toEqual(['u1', 'u3']);
	});

	it('keeps messages with toolUse undefined', () => {
		const result = messagesToLogEntries([makeMsg({ uuid: 'u1', toolUse: undefined })], 'sid');
		expect(result).toHaveLength(1);
	});

	it('keeps messages with empty toolUse array', () => {
		const result = messagesToLogEntries([makeMsg({ uuid: 'u1', toolUse: [] })], 'sid');
		expect(result).toHaveLength(1);
	});
});
