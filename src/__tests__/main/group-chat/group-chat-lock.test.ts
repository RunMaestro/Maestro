/**
 * @file group-chat-lock.test.ts
 * @description Unit tests for group chat lock and synthesis guard module.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
	acquireChatLock,
	releaseChatLock,
	isChatLocked,
	isSynthesisInProgress,
	markSynthesisStarted,
	clearSynthesisInProgress,
} from '../../../main/group-chat/group-chat-lock';

describe('group-chat/group-chat-lock', () => {
	// Use unique IDs to avoid state leakage between tests
	const getUniqueChatId = () => `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;

	describe('acquireChatLock', () => {
		it('should acquire lock on unlocked chat and return true', () => {
			const chatId = getUniqueChatId();
			expect(acquireChatLock(chatId, 'processing')).toBe(true);
			releaseChatLock(chatId); // cleanup
		});

		it('should return false when chat is already locked', () => {
			const chatId = getUniqueChatId();
			acquireChatLock(chatId, 'first operation');
			expect(acquireChatLock(chatId, 'second operation')).toBe(false);
			releaseChatLock(chatId); // cleanup
		});

		it('should auto-release stale lock and acquire new one', () => {
			const chatId = getUniqueChatId();
			vi.useFakeTimers();
			try {
				acquireChatLock(chatId, 'old operation');
				// Advance time past the 5 minute staleness threshold
				vi.advanceTimersByTime(300001);
				expect(acquireChatLock(chatId, 'new operation')).toBe(true);
				const state = isChatLocked(chatId);
				expect(state.locked).toBe(true);
				expect(state.operation).toBe('new operation');
			} finally {
				vi.useRealTimers();
				releaseChatLock(chatId);
			}
		});

		it('should store the operation name and startedAt timestamp', () => {
			const chatId = getUniqueChatId();
			const beforeTime = Date.now();
			acquireChatLock(chatId, 'test operation');
			const state = isChatLocked(chatId);
			expect(state.locked).toBe(true);
			expect(state.operation).toBe('test operation');
			expect(state.startedAt).toBeGreaterThanOrEqual(beforeTime);
			expect(state.startedAt).toBeLessThanOrEqual(Date.now());
			releaseChatLock(chatId); // cleanup
		});
	});

	describe('releaseChatLock', () => {
		it('should release an acquired lock', () => {
			const chatId = getUniqueChatId();
			acquireChatLock(chatId, 'processing');
			releaseChatLock(chatId);
			expect(isChatLocked(chatId).locked).toBe(false);
		});

		it('should be a no-op for unlocked chat', () => {
			const chatId = getUniqueChatId();
			// Should not throw
			releaseChatLock(chatId);
			expect(isChatLocked(chatId).locked).toBe(false);
		});
	});

	describe('isChatLocked', () => {
		it('should return { locked: false } for unlocked chat', () => {
			const chatId = getUniqueChatId();
			const state = isChatLocked(chatId);
			expect(state).toEqual({ locked: false });
		});

		it('should return lock info for locked chat', () => {
			const chatId = getUniqueChatId();
			acquireChatLock(chatId, 'testing');
			const state = isChatLocked(chatId);
			expect(state.locked).toBe(true);
			expect(state.operation).toBe('testing');
			expect(typeof state.startedAt).toBe('number');
			releaseChatLock(chatId); // cleanup
		});

		it('should auto-release stale lock and return unlocked', () => {
			const chatId = getUniqueChatId();
			vi.useFakeTimers();
			try {
				acquireChatLock(chatId, 'stale operation');
				vi.advanceTimersByTime(300001);
				const state = isChatLocked(chatId);
				expect(state).toEqual({ locked: false });
			} finally {
				vi.useRealTimers();
			}
		});

		it('should NOT auto-release lock that is just under 5 minutes old', () => {
			const chatId = getUniqueChatId();
			vi.useFakeTimers();
			try {
				acquireChatLock(chatId, 'recent operation');
				vi.advanceTimersByTime(299999); // Just under 5 minutes
				const state = isChatLocked(chatId);
				expect(state.locked).toBe(true);
				expect(state.operation).toBe('recent operation');
			} finally {
				vi.useRealTimers();
				releaseChatLock(chatId);
			}
		});
	});

	describe('Synthesis Guards', () => {
		describe('isSynthesisInProgress', () => {
			it('should return false for chat with no synthesis', () => {
				const chatId = getUniqueChatId();
				expect(isSynthesisInProgress(chatId)).toBe(false);
			});

			it('should return true after markSynthesisStarted', () => {
				const chatId = getUniqueChatId();
				markSynthesisStarted(chatId);
				expect(isSynthesisInProgress(chatId)).toBe(true);
				clearSynthesisInProgress(chatId); // cleanup
			});
		});

		describe('markSynthesisStarted', () => {
			it('should mark synthesis as in progress', () => {
				const chatId = getUniqueChatId();
				markSynthesisStarted(chatId);
				expect(isSynthesisInProgress(chatId)).toBe(true);
				clearSynthesisInProgress(chatId); // cleanup
			});

			it('should be idempotent', () => {
				const chatId = getUniqueChatId();
				markSynthesisStarted(chatId);
				markSynthesisStarted(chatId); // Should not throw
				expect(isSynthesisInProgress(chatId)).toBe(true);
				clearSynthesisInProgress(chatId); // cleanup
			});
		});

		describe('clearSynthesisInProgress', () => {
			it('should clear synthesis flag', () => {
				const chatId = getUniqueChatId();
				markSynthesisStarted(chatId);
				clearSynthesisInProgress(chatId);
				expect(isSynthesisInProgress(chatId)).toBe(false);
			});

			it('should be a no-op for chat without synthesis', () => {
				const chatId = getUniqueChatId();
				// Should not throw
				clearSynthesisInProgress(chatId);
				expect(isSynthesisInProgress(chatId)).toBe(false);
			});
		});
	});

	describe('Integration: Lock and Synthesis Interaction', () => {
		it('should allow lock and synthesis to operate independently', () => {
			const chatId = getUniqueChatId();
			acquireChatLock(chatId, 'processing');
			markSynthesisStarted(chatId);

			expect(isChatLocked(chatId).locked).toBe(true);
			expect(isSynthesisInProgress(chatId)).toBe(true);

			releaseChatLock(chatId);
			expect(isChatLocked(chatId).locked).toBe(false);
			expect(isSynthesisInProgress(chatId)).toBe(true);

			clearSynthesisInProgress(chatId);
			expect(isSynthesisInProgress(chatId)).toBe(false);
		});

		it('should allow re-acquisition after release', () => {
			const chatId = getUniqueChatId();
			acquireChatLock(chatId, 'first');
			releaseChatLock(chatId);
			expect(acquireChatLock(chatId, 'second')).toBe(true);
			const state = isChatLocked(chatId);
			expect(state.operation).toBe('second');
			releaseChatLock(chatId); // cleanup
		});
	});
});
