/**
 * Tests for usage listener.
 * Forwards token/cost statistics from AI responses to the renderer and hands group chat ones to
 * the engine. What the engine does with them (the turn ledger, the participant and moderator cards)
 * is covered by `src/shared/maestro-lib/groupchat/__tests__/observations.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupUsageListener } from '../usage-listener';
import type { ProcessManager } from '../../process-manager';
import type { UsageStats } from '../types';

describe('Usage Listener', () => {
	let mockProcessManager: ProcessManager;
	let mockDeps: Parameters<typeof setupUsageListener>[1];
	let usageReported: ReturnType<typeof vi.fn>;
	let eventHandlers: Map<string, (...args: unknown[]) => void>;

	const createMockUsageStats = (overrides: Partial<UsageStats> = {}): UsageStats => ({
		inputTokens: 1000,
		outputTokens: 500,
		cacheReadInputTokens: 200,
		cacheCreationInputTokens: 100,
		totalCostUsd: 0.05,
		contextWindow: 100000,
		...overrides,
	});

	beforeEach(() => {
		vi.clearAllMocks();
		eventHandlers = new Map();
		usageReported = vi.fn();

		mockProcessManager = {
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				eventHandlers.set(event, handler);
			}),
		} as unknown as ProcessManager;

		mockDeps = {
			safeSend: vi.fn(),
			groupChatEngine: { usageReported } as never,
		};
	});

	const setupListener = () => {
		setupUsageListener(mockProcessManager, mockDeps);
	};

	describe('Event Registration', () => {
		it('should register the usage event listener', () => {
			setupListener();
			expect(mockProcessManager.on).toHaveBeenCalledWith('usage', expect.any(Function));
		});
	});

	describe('Regular Process Usage', () => {
		it('should forward usage stats to renderer', () => {
			setupListener();
			const handler = eventHandlers.get('usage');
			const usageStats = createMockUsageStats();

			handler?.('regular-session-123', usageStats);

			expect(mockDeps.safeSend).toHaveBeenCalledWith(
				'process:usage',
				'regular-session-123',
				usageStats
			);
		});

		it('should forward usage stats with reasoning tokens', () => {
			setupListener();
			const handler = eventHandlers.get('usage');

			handler?.('regular-session-123', createMockUsageStats({ reasoningTokens: 1000 }));

			expect(mockDeps.safeSend).toHaveBeenCalledWith(
				'process:usage',
				'regular-session-123',
				expect.objectContaining({ reasoningTokens: 1000 })
			);
		});

		it('should skip the engine for sessions that are not a group chat (prefix check)', () => {
			setupListener();
			const handler = eventHandlers.get('usage');

			for (let i = 0; i < 100; i++) handler?.(`regular-session-${i}`, createMockUsageStats());

			expect(usageReported).not.toHaveBeenCalled();
			expect(mockDeps.safeSend).toHaveBeenCalledTimes(100);
		});
	});

	describe('Group chat sessions', () => {
		it.each([
			['participant', 'group-chat-test-chat-123-participant-TestAgent-abc123'],
			['moderator', 'group-chat-test-chat-123-moderator-1234567890'],
			['synthesis moderator', 'group-chat-test-chat-123-moderator-synthesis-1234567890'],
		])('should hand %s usage to the engine and still forward it', (_label, sessionId) => {
			setupListener();
			const handler = eventHandlers.get('usage');
			const usageStats = createMockUsageStats();

			handler?.(sessionId, usageStats);

			expect(usageReported).toHaveBeenCalledWith(sessionId, usageStats);
			expect(mockDeps.safeSend).toHaveBeenCalledWith('process:usage', sessionId, usageStats);
		});
	});
});
