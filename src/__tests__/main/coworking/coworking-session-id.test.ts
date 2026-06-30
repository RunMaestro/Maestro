import { describe, it, expect } from 'vitest';
import { resolveOwningMaestroSessionId } from '../../../main/coworking/coworking-session-id';

describe('resolveOwningMaestroSessionId', () => {
	it('extracts the bare session id from an AI-tab composite', () => {
		expect(resolveOwningMaestroSessionId('session-123-ai-tab1')).toBe('session-123');
	});

	it('strips the forced-parallel suffix', () => {
		expect(resolveOwningMaestroSessionId('session-123-ai-tab1-fp-1712611230000')).toBe(
			'session-123'
		);
	});

	it('handles UUID-shaped session ids with embedded hyphens correctly', () => {
		const sid = '6e58a6c2-2b3f-4f81-9a1e-7b1f3a3a4444';
		expect(resolveOwningMaestroSessionId(`${sid}-ai-default`)).toBe(sid);
		expect(resolveOwningMaestroSessionId(`${sid}-ai-tab-with-dashes`)).toBe(sid);
	});

	it('handles the legacy `-ai` suffix', () => {
		expect(resolveOwningMaestroSessionId('session-123-ai')).toBe('session-123');
	});

	it('passes through non-composite ids unchanged', () => {
		expect(resolveOwningMaestroSessionId('session-123')).toBe('session-123');
		expect(resolveOwningMaestroSessionId('group-chat-abc-moderator-1')).toBe(
			'group-chat-abc-moderator-1'
		);
		expect(resolveOwningMaestroSessionId('session-123-synopsis-1234567890')).toBe(
			'session-123-synopsis-1234567890'
		);
		expect(resolveOwningMaestroSessionId('session-123-batch-1234567890')).toBe(
			'session-123-batch-1234567890'
		);
	});

	it('does NOT misinterpret `-ai` inside the project name as a tab marker', () => {
		// e.g. project named "openai-tools" used as part of a session id
		expect(resolveOwningMaestroSessionId('openai-tools-session')).toBe('openai-tools-session');
	});
});
