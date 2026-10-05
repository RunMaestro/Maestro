/**
 * Tests for session ID listener.
 * Forwards agent session IDs to the renderer and hands group chat ones to the engine. What the
 * engine does with them (storage, the UI events, the failure handling) is covered by
 * `src/shared/maestro-lib/groupchat/__tests__/observations.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupSessionIdListener } from '../session-id-listener';
import type { ProcessManager } from '../../process-manager';

describe('Session ID Listener', () => {
	let mockProcessManager: ProcessManager;
	let mockDeps: Parameters<typeof setupSessionIdListener>[1];
	let sessionAnnounced: ReturnType<typeof vi.fn>;
	let eventHandlers: Map<string, (...args: unknown[]) => void>;

	beforeEach(() => {
		vi.clearAllMocks();
		eventHandlers = new Map();
		sessionAnnounced = vi.fn().mockResolvedValue(undefined);

		mockProcessManager = {
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				eventHandlers.set(event, handler);
			}),
		} as unknown as ProcessManager;

		mockDeps = {
			safeSend: vi.fn(),
			groupChatEngine: { sessionAnnounced } as never,
		};
	});

	const setupListener = () => {
		setupSessionIdListener(mockProcessManager, mockDeps);
	};

	describe('Event Registration', () => {
		it('should register the session-id event listener', () => {
			setupListener();
			expect(mockProcessManager.on).toHaveBeenCalledWith('session-id', expect.any(Function));
		});
	});

	describe('Regular Process Session ID', () => {
		it('should forward session ID to renderer', () => {
			setupListener();
			const handler = eventHandlers.get('session-id');

			handler?.('regular-session-123', 'agent-session-abc');

			expect(mockDeps.safeSend).toHaveBeenCalledWith(
				'process:session-id',
				'regular-session-123',
				'agent-session-abc'
			);
		});

		it('should skip the engine for sessions that are not a group chat (prefix check)', () => {
			setupListener();
			const handler = eventHandlers.get('session-id');

			for (let i = 0; i < 100; i++) handler?.(`regular-session-${i}`, `agent-session-${i}`);

			expect(sessionAnnounced).not.toHaveBeenCalled();
			expect(mockDeps.safeSend).toHaveBeenCalledTimes(100);
		});

		it.each([
			['empty', ''],
			['UUID', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'],
			['long', 'a'.repeat(500)],
		])('should forward a %s agent session ID unchanged', (_label, agentSessionId) => {
			setupListener();
			const handler = eventHandlers.get('session-id');

			handler?.('regular-session-123', agentSessionId);

			expect(mockDeps.safeSend).toHaveBeenCalledWith(
				'process:session-id',
				'regular-session-123',
				agentSessionId
			);
		});
	});

	describe('Group chat sessions', () => {
		it.each([
			['participant', 'group-chat-test-chat-123-participant-TestAgent-abc123'],
			['moderator', 'group-chat-test-chat-123-moderator-1234567890'],
			['synthesis moderator', 'group-chat-test-chat-123-moderator-synthesis-1234567890'],
		])('should hand a %s session ID to the engine and still forward it', (_label, sessionId) => {
			setupListener();
			const handler = eventHandlers.get('session-id');

			handler?.(sessionId, 'agent-session-xyz');

			expect(sessionAnnounced).toHaveBeenCalledWith(sessionId, 'agent-session-xyz');
			expect(mockDeps.safeSend).toHaveBeenCalledWith(
				'process:session-id',
				sessionId,
				'agent-session-xyz'
			);
		});
	});
});
