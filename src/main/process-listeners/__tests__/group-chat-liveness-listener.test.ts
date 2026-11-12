/**
 * Tests for the Group Chat liveness listener.
 *
 * This listener is the only thing that re-arms the router's per-turn silence
 * budgets, so its wiring IS the fix: miss an event here and the budget silently
 * degrades back into the wall-clock timeout that killed working participants.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const noteGroupChatActivity = vi.fn();
vi.mock('../../group-chat/group-chat-router', () => ({
	noteGroupChatActivity: (sessionId: string) => noteGroupChatActivity(sessionId),
}));

import { setupGroupChatLivenessListener } from '../group-chat-liveness-listener';
import { AGENT_LIVENESS_EVENTS } from '../../utils/agent-liveness';
import type { ProcessManager } from '../../process-manager';

const MODERATOR_SESSION = 'group-chat-abc-moderator-1';
const PARTICIPANT_SESSION = 'group-chat-abc-participant-rc-1';

describe('Group Chat liveness listener', () => {
	let handlers: Map<string, (...args: unknown[]) => void>;
	let processManager: ProcessManager;

	beforeEach(() => {
		vi.clearAllMocks();
		handlers = new Map();
		processManager = {
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				handlers.set(event, handler);
			}),
		} as unknown as ProcessManager;
		setupGroupChatLivenessListener(processManager);
	});

	// `data` alone is a hard deadline for stream-json agents, which emit nothing
	// on it until the turn is completely finished.
	it('subscribes to every shared liveness event plus raw-stdout', () => {
		for (const event of AGENT_LIVENESS_EVENTS) {
			expect(handlers.has(event)).toBe(true);
		}
		expect(handlers.has('raw-stdout')).toBe(true);
	});

	it.each([...AGENT_LIVENESS_EVENTS, 'raw-stdout'])(
		'reports a participant turn as alive on %s',
		(event) => {
			handlers.get(event)?.(PARTICIPANT_SESSION, 'chunk');
			expect(noteGroupChatActivity).toHaveBeenCalledWith(PARTICIPANT_SESSION);
		}
	);

	it('reports a moderator turn as alive too', () => {
		handlers.get('raw-stdout')?.(MODERATOR_SESSION, 'chunk');
		expect(noteGroupChatActivity).toHaveBeenCalledWith(MODERATOR_SESSION);
	});

	it('ignores sessions that are not group chats', () => {
		handlers.get('raw-stdout')?.('some-agent-session-ai-1', 'chunk');
		handlers.get('data')?.('another-session', 'chunk');
		expect(noteGroupChatActivity).not.toHaveBeenCalled();
	});
});
