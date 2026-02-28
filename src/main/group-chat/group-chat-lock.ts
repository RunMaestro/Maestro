/**
 * @file group-chat-lock.ts
 * @description Race condition guards for Group Chat operations.
 *
 * Provides:
 * - Chat-level operation locks to prevent concurrent delete/update during processing
 * - Synthesis-in-progress guards to prevent double-trigger
 */

const STALE_LOCK_TIMEOUT_MS = 300000; // 5 minutes

interface LockEntry {
	operation: string;
	startedAt: number;
}

/** Module-level lock map: chatId -> lock info */
const chatLocks = new Map<string, LockEntry>();

/** Module-level synthesis guard: chatId set */
const synthesisInProgress = new Set<string>();

// ========== Chat Lock ==========

/**
 * Attempt to acquire a lock on a group chat for an operation.
 * If already locked and lock is < 5 minutes old, returns false.
 * If lock is stale (>5min), auto-releases it and acquires.
 *
 * @param chatId - The group chat ID to lock
 * @param operation - Description of the operation holding the lock
 * @returns true if lock was acquired, false if already locked
 */
export function acquireChatLock(chatId: string, operation: string): boolean {
	const existing = chatLocks.get(chatId);
	if (existing) {
		if (Date.now() - existing.startedAt < STALE_LOCK_TIMEOUT_MS) {
			return false;
		}
		// Stale lock - auto-release
		chatLocks.delete(chatId);
	}
	chatLocks.set(chatId, { operation, startedAt: Date.now() });
	return true;
}

/**
 * Release the lock on a group chat.
 *
 * @param chatId - The group chat ID to unlock
 */
export function releaseChatLock(chatId: string): void {
	chatLocks.delete(chatId);
}

/**
 * Check if a group chat is locked.
 * Applies staleness check - if stale, auto-releases and returns unlocked.
 *
 * @param chatId - The group chat ID to check
 * @returns Lock state with optional operation and startedAt
 */
export function isChatLocked(chatId: string): {
	locked: boolean;
	operation?: string;
	startedAt?: number;
} {
	const existing = chatLocks.get(chatId);
	if (!existing) {
		return { locked: false };
	}
	if (Date.now() - existing.startedAt >= STALE_LOCK_TIMEOUT_MS) {
		chatLocks.delete(chatId);
		return { locked: false };
	}
	return { locked: true, operation: existing.operation, startedAt: existing.startedAt };
}

// ========== Synthesis Guards ==========

/**
 * Check if synthesis is in progress for a group chat.
 *
 * @param chatId - The group chat ID to check
 * @returns true if synthesis is currently in progress
 */
export function isSynthesisInProgress(chatId: string): boolean {
	return synthesisInProgress.has(chatId);
}

/**
 * Mark synthesis as started for a group chat.
 *
 * @param chatId - The group chat ID
 */
export function markSynthesisStarted(chatId: string): void {
	synthesisInProgress.add(chatId);
}

/**
 * Clear the synthesis-in-progress flag for a group chat.
 *
 * @param chatId - The group chat ID
 */
export function clearSynthesisInProgress(chatId: string): void {
	synthesisInProgress.delete(chatId);
}
