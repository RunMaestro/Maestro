/**
 * Tests for session ID listener.
 * Forwards agent session IDs to the renderer and hands group chat ones to the engine. What the
 * engine does with them (storage, the UI events, the failure handling) is covered by
 * `src/shared/maestro-lib/groupchat/__tests__/observations.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { setupSessionIdListener } from '../session-id-listener';
import type { ProcessManager } from '../../process-manager';
import type { NativeSessionLaunch } from '../../process-manager/types';
import { getSettingsStore, getSessionsStore, getAgentConfigsStore } from '../../stores/getters';

// A bridge must use the immutable receipt, never re-label it from current stores.
vi.mock('../../stores/getters', () => ({
	getSettingsStore: vi.fn(),
	getSessionsStore: vi.fn(),
	getAgentConfigsStore: vi.fn(),
}));

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
			nativeSessionLaunchOf: vi.fn().mockReturnValue(undefined),
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				eventHandlers.set(event, handler);
			}),
		} as unknown as ProcessManager;

		mockDeps = {
			safeSend: vi.fn(),
			groupChatEngine: { sessionAnnounced } as never,
		};
	});

	afterEach(() => {
		expect(getSettingsStore).not.toHaveBeenCalled();
		expect(getSessionsStore).not.toHaveBeenCalled();
		expect(getAgentConfigsStore).not.toHaveBeenCalled();
		vi.restoreAllMocks();
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

	describe('Native launch receipt forwarding', () => {
		it.each(['local', 'ssh'] as const)(
			'preserves exact %s account, host, cwd, tab, generation and separate IDs',
			(kind) => {
				const receipt: NativeSessionLaunch = Object.freeze({
					scope: Object.freeze({
						version: 1,
						state: 'bound',
						provider: 'grok',
						accountRef: `grok:${kind}:account-a`,
						host: Object.freeze({ kind, identity: `${kind}:observed-host-a` }),
						cwd:
							kind === 'local' ? path.resolve('fixture project', '日本語') : '/srv/日本語 project',
					}),
					processGeneration: 41,
					tabId: 'owning-tab-a',
					requestedNativeSessionId: 'requested-original',
					nativeSessionRequestId: 'attempt-a',
				});
				vi.mocked(mockProcessManager.nativeSessionLaunchOf).mockReturnValue(receipt);
				setupListener();

				eventHandlers.get('session-id')!('agent-ai-owning-tab-a', 'observed-different');

				expect(mockProcessManager.nativeSessionLaunchOf).toHaveBeenCalledExactlyOnceWith(
					'agent-ai-owning-tab-a'
				);
				expect(vi.mocked(mockDeps.safeSend).mock.calls).toEqual([
					['process:session-id', 'agent-ai-owning-tab-a', 'observed-different', receipt],
				]);
				expect(vi.mocked(mockDeps.safeSend).mock.calls[0][3]).toBe(receipt);
				expect(receipt.requestedNativeSessionId).toBe('requested-original');
				expect(receipt.scope).not.toHaveProperty('nativeSessionId');
				expect(sessionAnnounced).not.toHaveBeenCalled();
			}
		);

		it.each(['legacy', 'unobserved'] as const)(
			'forwards %s scope without inventing account ownership or optional fields',
			(reason) => {
				const receipt: NativeSessionLaunch = {
					scope: { version: 1, state: 'unknown', reason },
					processGeneration: 9,
				};
				vi.mocked(mockProcessManager.nativeSessionLaunchOf).mockReturnValue(receipt);
				setupListener();

				eventHandlers.get('session-id')!('agent-ai-tab-a', 'actual-native-id');

				expect(vi.mocked(mockDeps.safeSend).mock.calls).toEqual([
					['process:session-id', 'agent-ai-tab-a', 'actual-native-id', receipt],
				]);
				expect(receipt).toEqual({
					scope: { version: 1, state: 'unknown', reason },
					processGeneration: 9,
				});
			}
		);

		it('does not reuse an earlier receipt when a later event has none', () => {
			const receipt: NativeSessionLaunch = {
				scope: { version: 1, state: 'unknown', reason: 'unobserved' },
				processGeneration: 1,
				tabId: 'tab-a',
			};
			vi.mocked(mockProcessManager.nativeSessionLaunchOf).mockReturnValueOnce(receipt);
			setupListener();
			const handler = eventHandlers.get('session-id')!;

			handler('agent-ai-tab-a', 'same-native-id');
			handler('agent-ai-tab-b', 'same-native-id');

			expect(vi.mocked(mockDeps.safeSend).mock.calls).toEqual([
				['process:session-id', 'agent-ai-tab-a', 'same-native-id', receipt],
				['process:session-id', 'agent-ai-tab-b', 'same-native-id'],
			]);
			expect(vi.mocked(mockProcessManager.nativeSessionLaunchOf).mock.calls).toEqual([
				['agent-ai-tab-a'],
				['agent-ai-tab-b'],
			]);
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

		it('captures the receipt before synchronous group-chat delegation clears it', () => {
			const sessionId = 'group-chat-test-participant-Grok-turn';
			const receipt: NativeSessionLaunch = {
				scope: {
					version: 1,
					state: 'bound',
					provider: 'grok',
					accountRef: 'grok:remote:account-b',
					host: { kind: 'ssh', identity: 'ssh:observed-host-b' },
					cwd: '/srv/project-b',
				},
				processGeneration: 12,
				tabId: 'tab-b',
				nativeSessionRequestId: 'attempt-b',
			};
			const readReceipt = vi.mocked(mockProcessManager.nativeSessionLaunchOf);
			readReceipt.mockReturnValue(receipt);
			sessionAnnounced.mockImplementation(() => {
				expect(readReceipt).toHaveBeenCalledExactlyOnceWith(sessionId);
				expect(mockDeps.safeSend).not.toHaveBeenCalled();
				readReceipt.mockReturnValue(undefined);
				return Promise.resolve();
			});
			setupListener();

			eventHandlers.get('session-id')!(sessionId, 'confirmed-native-allocation');

			expect(sessionAnnounced).toHaveBeenCalledExactlyOnceWith(
				sessionId,
				'confirmed-native-allocation'
			);
			expect(readReceipt).toHaveBeenCalledTimes(1);
			expect(vi.mocked(mockDeps.safeSend).mock.calls).toEqual([
				['process:session-id', sessionId, 'confirmed-native-allocation', receipt],
			]);
		});
	});
});
