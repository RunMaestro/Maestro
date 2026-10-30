import { describe, expect, it } from 'vitest';
import type { Permission } from '@opencode-ai/sdk';
import {
	opencodePermissionOpenRequest,
	opencodePermissionResponse,
} from '../../../main/opencode-server/permission-requests';

const permission: Permission = {
	id: 'permission-a',
	type: 'shell',
	pattern: 'bun test',
	sessionID: 'session-a',
	messageID: 'message-a',
	callID: 'call-a',
	title: 'Run the test suite?',
	metadata: { command: 'bun test' },
	time: { created: 1 },
};

describe('OpenCode permission requests', () => {
	it('preserves native identity, details, and response options', () => {
		expect(
			opencodePermissionOpenRequest(permission, {
				sessionId: 'maestro-session-a',
				tabId: 'tab-a',
				spawnGeneration: 2,
			})
		).toMatchObject({
			sessionId: 'maestro-session-a',
			tabId: 'tab-a',
			spawnGeneration: 2,
			turnId: 'message-a',
			toolCallId: 'call-a',
			kind: 'permission',
			options: [
				{ optionId: 'once', kind: 'allow-once' },
				{ optionId: 'always', kind: 'allow-always' },
				{ optionId: 'reject', kind: 'reject-once' },
			],
		});
	});

	it('maps the current permission.asked payload', () => {
		expect(
			opencodePermissionOpenRequest(
				{
					id: 'permission-current',
					sessionID: 'opencode-session',
					permission: 'bash',
					patterns: ['bun test'],
					metadata: {},
					always: ['bun *'],
					tool: { messageID: 'message-current', callID: 'call-current' },
				},
				{ sessionId: 'maestro-session-a', spawnGeneration: 1 }
			)
		).toMatchObject({
			turnId: 'message-current',
			toolCallId: 'call-current',
			toolName: 'bash',
			input: { pattern: ['bun test'], always: ['bun *'] },
		});
	});

	it('maps native responses and fails closed on cancellation or unexpected input', () => {
		expect(opencodePermissionResponse({ outcome: 'selected', optionId: 'once' })).toBe('once');
		expect(opencodePermissionResponse({ outcome: 'selected', optionId: 'always' })).toBe('always');
		expect(opencodePermissionResponse({ outcome: 'selected', optionId: 'reject' })).toBe('reject');
		expect(opencodePermissionResponse({ outcome: 'cancelled', reason: 'timeout' })).toBe('reject');
		expect(opencodePermissionResponse({ outcome: 'answers', answers: {} })).toBe('reject');
	});
});
