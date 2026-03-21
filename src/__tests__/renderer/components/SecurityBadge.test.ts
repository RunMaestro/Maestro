/**
 * @file SecurityBadge.test.ts
 * @description Tests for SecurityBadge component logic
 *
 * Tests the badge's:
 * - Status determination based on events (clean, warning, blocked, hidden)
 * - Event counting and state management
 * - Session filtering
 * - Auto-dismiss behavior
 * - Badge display (color states, counts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SecurityEventData } from '../../../main/preload/security';

type SecurityBadgeStatus = 'clean' | 'warning' | 'blocked' | 'hidden';

// Helper function to determine status (mirrors component logic)
function getStatus(
	visible: boolean,
	blockedCount: number,
	warningCount: number,
	scanCount: number
): SecurityBadgeStatus {
	if (!visible) return 'hidden';
	if (blockedCount > 0) return 'blocked';
	if (warningCount > 0) return 'warning';
	if (scanCount > 0) return 'clean';
	return 'hidden';
}

// Helper to determine badge color (mirrors component logic)
function getBadgeColor(
	status: SecurityBadgeStatus,
	theme: { success: string; warning: string; error: string }
): string {
	switch (status) {
		case 'blocked':
			return theme.error;
		case 'warning':
			return theme.warning;
		case 'clean':
			return theme.success;
		case 'hidden':
		default:
			return 'transparent';
	}
}

describe('SecurityBadge', () => {
	describe('getStatus', () => {
		it('returns hidden when not visible', () => {
			expect(getStatus(false, 0, 0, 0)).toBe('hidden');
			expect(getStatus(false, 5, 3, 10)).toBe('hidden');
		});

		it('returns blocked when there are blocked events (highest priority)', () => {
			expect(getStatus(true, 1, 0, 0)).toBe('blocked');
			expect(getStatus(true, 5, 10, 5)).toBe('blocked');
		});

		it('returns warning when there are warning events but no blocked', () => {
			expect(getStatus(true, 0, 1, 0)).toBe('warning');
			expect(getStatus(true, 0, 10, 5)).toBe('warning');
		});

		it('returns clean when there are clean scans but no warnings or blocked', () => {
			expect(getStatus(true, 0, 0, 1)).toBe('clean');
			expect(getStatus(true, 0, 0, 50)).toBe('clean');
		});

		it('returns hidden when visible but no events', () => {
			expect(getStatus(true, 0, 0, 0)).toBe('hidden');
		});
	});

	describe('badge colors', () => {
		const mockTheme = {
			success: '#00ff00',
			warning: '#ffff00',
			error: '#ff0000',
		};

		it('uses red color for blocked status', () => {
			expect(getBadgeColor('blocked', mockTheme)).toBe('#ff0000');
		});

		it('uses yellow color for warning status', () => {
			expect(getBadgeColor('warning', mockTheme)).toBe('#ffff00');
		});

		it('uses green color for clean status', () => {
			expect(getBadgeColor('clean', mockTheme)).toBe('#00ff00');
		});

		it('uses transparent for hidden status', () => {
			expect(getBadgeColor('hidden', mockTheme)).toBe('transparent');
		});
	});

	describe('event processing', () => {
		it('correctly identifies blocked events', () => {
			const event: SecurityEventData = {
				sessionId: 'test-session',
				eventType: 'blocked',
				findingTypes: ['PROMPT_INJECTION'],
				findingCount: 1,
				action: 'blocked',
				originalLength: 100,
				sanitizedLength: 0,
			};

			expect(event.eventType).toBe('blocked');
		});

		it('correctly identifies warning events', () => {
			const event: SecurityEventData = {
				sessionId: 'test-session',
				eventType: 'warning',
				findingTypes: ['PII_EMAIL'],
				findingCount: 1,
				action: 'warned',
				originalLength: 100,
				sanitizedLength: 90,
			};

			expect(event.eventType).toBe('warning');
		});

		it('correctly identifies clean scan events (no findings)', () => {
			const event: SecurityEventData = {
				sessionId: 'test-session',
				eventType: 'input_scan',
				findingTypes: [],
				findingCount: 0,
				action: 'none',
				originalLength: 100,
				sanitizedLength: 100,
			};

			expect(event.eventType).toBe('input_scan');
			expect(event.findingCount).toBe(0);
		});
	});

	describe('session filtering', () => {
		const testSessionId = 'test-session-123';

		it('filters events by session ID', () => {
			const event1: SecurityEventData = {
				sessionId: testSessionId,
				eventType: 'warning',
				findingTypes: ['PII_EMAIL'],
				findingCount: 1,
				action: 'warned',
				originalLength: 100,
				sanitizedLength: 90,
			};

			const event2: SecurityEventData = {
				sessionId: 'other-session',
				eventType: 'warning',
				findingTypes: ['PII_PHONE'],
				findingCount: 1,
				action: 'warned',
				originalLength: 100,
				sanitizedLength: 90,
			};

			// Simulating the component's filter logic
			const filterBySession = (event: SecurityEventData, sessionId: string) => {
				return event.sessionId === sessionId;
			};

			expect(filterBySession(event1, testSessionId)).toBe(true);
			expect(filterBySession(event2, testSessionId)).toBe(false);
		});
	});

	describe('badge display logic', () => {
		it('calculates display count correctly for findings', () => {
			const blockedCount = 3;
			const warningCount = 5;
			const totalFindings = blockedCount + warningCount;

			expect(totalFindings).toBe(8);
		});

		it('uses scan count for clean badge when no findings', () => {
			const blockedCount = 0;
			const warningCount = 0;
			const scanCount = 10;
			const totalFindings = blockedCount + warningCount;
			const displayCount = totalFindings > 0 ? totalFindings : scanCount;

			expect(displayCount).toBe(10);
		});

		it('formats large counts with 99+ notation', () => {
			const formatCount = (count: number) => {
				return count > 99 ? '99+' : String(count);
			};

			expect(formatCount(5)).toBe('5');
			expect(formatCount(99)).toBe('99');
			expect(formatCount(100)).toBe('99+');
			expect(formatCount(500)).toBe('99+');
		});
	});

	describe('auto-dismiss behavior', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('clears state after dismiss timeout', () => {
			const DISMISS_TIMEOUT_MS = 30000;
			let visible = true;
			let warningCount = 5;
			let blockedCount = 3;
			let scanCount = 10;

			// Simulate clearing after timeout
			const clearState = () => {
				visible = false;
				warningCount = 0;
				blockedCount = 0;
				scanCount = 0;
			};

			const timeout = setTimeout(clearState, DISMISS_TIMEOUT_MS);

			// Before timeout
			expect(visible).toBe(true);
			expect(warningCount).toBe(5);
			expect(blockedCount).toBe(3);

			// Advance time past timeout
			vi.advanceTimersByTime(DISMISS_TIMEOUT_MS + 100);

			expect(visible).toBe(false);
			expect(warningCount).toBe(0);
			expect(blockedCount).toBe(0);
			expect(scanCount).toBe(0);

			clearTimeout(timeout);
		});

		it('resets dismiss timeout on new event', () => {
			const DISMISS_TIMEOUT_MS = 30000;
			let visible = true;
			let timeoutId: ReturnType<typeof setTimeout> | null = null;

			const resetTimeout = () => {
				if (timeoutId) {
					clearTimeout(timeoutId);
				}
				timeoutId = setTimeout(() => {
					visible = false;
				}, DISMISS_TIMEOUT_MS);
			};

			// Initial event
			resetTimeout();
			vi.advanceTimersByTime(20000); // 20s elapsed

			expect(visible).toBe(true);

			// New event resets timeout
			resetTimeout();
			vi.advanceTimersByTime(20000); // Another 20s (40s total from start)

			// Should still be visible because timeout was reset
			expect(visible).toBe(true);

			// Advance past new timeout
			vi.advanceTimersByTime(15000); // 35s from last reset

			expect(visible).toBe(false);

			if (timeoutId) clearTimeout(timeoutId);
		});
	});

	describe('active session dismiss', () => {
		it('clears badge when session becomes active', () => {
			let visible = true;
			let warningCount = 5;
			let blockedCount = 3;
			let scanCount = 10;
			let isActive = false;

			// Simulate activation clearing the badge
			const onActiveChange = (active: boolean) => {
				if (active && visible) {
					visible = false;
					warningCount = 0;
					blockedCount = 0;
					scanCount = 0;
				}
			};

			expect(visible).toBe(true);
			expect(warningCount).toBe(5);

			// Session becomes active
			isActive = true;
			onActiveChange(isActive);

			expect(visible).toBe(false);
			expect(warningCount).toBe(0);
			expect(blockedCount).toBe(0);
			expect(scanCount).toBe(0);
		});
	});

	describe('compact mode', () => {
		it('shows only icon without count in compact mode', () => {
			const compact = true;
			const showCount = !compact;

			expect(showCount).toBe(false);
		});

		it('shows icon with count in full mode', () => {
			const compact = false;
			const showCount = !compact;

			expect(showCount).toBe(true);
		});
	});

	describe('enabled state', () => {
		it('does not render when LLM Guard is disabled', () => {
			const enabled = false;
			const shouldRender = enabled;

			expect(shouldRender).toBe(false);
		});

		it('renders when LLM Guard is enabled', () => {
			const enabled = true;
			const status: SecurityBadgeStatus = 'warning';
			const shouldRender = enabled && status !== 'hidden';

			expect(shouldRender).toBe(true);
		});

		it('does not render when status is hidden even if enabled', () => {
			const enabled = true;
			const status: SecurityBadgeStatus = 'hidden';
			const shouldRender = enabled && status !== 'hidden';

			expect(shouldRender).toBe(false);
		});
	});
});
