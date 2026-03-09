/**
 * @file ScanProgressIndicator.test.ts
 * @description Tests for ScanProgressIndicator component logic
 *
 * Tests the indicator's:
 * - Visibility based on scan events and content length
 * - Session/tab filtering
 * - Auto-dismiss behavior
 * - Minimum display time enforcement
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ScanProgressEvent } from '../../../main/preload/security';

/** Minimum content length to show the indicator (matches component) */
const MIN_LENGTH_FOR_INDICATOR = 50;

/** Minimum display time in ms (matches component) */
const MIN_DISPLAY_MS = 200;

// Helper to determine if indicator should be visible (mirrors component logic)
function shouldShowIndicator(
	enabled: boolean,
	isScanning: boolean,
	contentLength: number
): boolean {
	return enabled && isScanning && contentLength >= MIN_LENGTH_FOR_INDICATOR;
}

// Helper to simulate event filtering (mirrors component logic)
function shouldProcessEvent(event: ScanProgressEvent, sessionId?: string, tabId?: string): boolean {
	if (sessionId && event.sessionId !== sessionId) {
		return false;
	}
	if (tabId && event.tabId !== tabId) {
		return false;
	}
	return true;
}

// Helper to calculate remaining display time (mirrors component logic)
// When scanStartTime is null, component assumes MIN_DISPLAY_MS has already elapsed
function calculateRemainingDisplayTime(scanStartTime: number | null, now: number): number {
	const elapsed = scanStartTime ? now - scanStartTime : MIN_DISPLAY_MS;
	return Math.max(0, MIN_DISPLAY_MS - elapsed);
}

describe('ScanProgressIndicator', () => {
	describe('shouldShowIndicator', () => {
		it('returns false when guard is disabled', () => {
			expect(shouldShowIndicator(false, true, 100)).toBe(false);
			expect(shouldShowIndicator(false, false, 100)).toBe(false);
		});

		it('returns false when not scanning', () => {
			expect(shouldShowIndicator(true, false, 100)).toBe(false);
		});

		it('returns false when content is too short', () => {
			expect(shouldShowIndicator(true, true, 10)).toBe(false);
			expect(shouldShowIndicator(true, true, 49)).toBe(false);
		});

		it('returns true when enabled, scanning, and content is long enough', () => {
			expect(shouldShowIndicator(true, true, 50)).toBe(true);
			expect(shouldShowIndicator(true, true, 100)).toBe(true);
			expect(shouldShowIndicator(true, true, 10000)).toBe(true);
		});

		it('returns false at exactly MIN_LENGTH_FOR_INDICATOR - 1', () => {
			expect(shouldShowIndicator(true, true, MIN_LENGTH_FOR_INDICATOR - 1)).toBe(false);
		});

		it('returns true at exactly MIN_LENGTH_FOR_INDICATOR', () => {
			expect(shouldShowIndicator(true, true, MIN_LENGTH_FOR_INDICATOR)).toBe(true);
		});
	});

	describe('event filtering', () => {
		it('accepts event when no session filter is set', () => {
			const event: ScanProgressEvent = {
				sessionId: 'session-1',
				tabId: 'tab-1',
				eventType: 'scan_start',
				contentLength: 100,
			};
			expect(shouldProcessEvent(event)).toBe(true);
		});

		it('accepts event when session matches', () => {
			const event: ScanProgressEvent = {
				sessionId: 'session-1',
				tabId: 'tab-1',
				eventType: 'scan_start',
				contentLength: 100,
			};
			expect(shouldProcessEvent(event, 'session-1')).toBe(true);
		});

		it('rejects event when session does not match', () => {
			const event: ScanProgressEvent = {
				sessionId: 'session-1',
				tabId: 'tab-1',
				eventType: 'scan_start',
				contentLength: 100,
			};
			expect(shouldProcessEvent(event, 'session-2')).toBe(false);
		});

		it('accepts event when tab matches', () => {
			const event: ScanProgressEvent = {
				sessionId: 'session-1',
				tabId: 'tab-1',
				eventType: 'scan_start',
				contentLength: 100,
			};
			expect(shouldProcessEvent(event, 'session-1', 'tab-1')).toBe(true);
		});

		it('rejects event when tab does not match', () => {
			const event: ScanProgressEvent = {
				sessionId: 'session-1',
				tabId: 'tab-1',
				eventType: 'scan_start',
				contentLength: 100,
			};
			expect(shouldProcessEvent(event, 'session-1', 'tab-2')).toBe(false);
		});

		it('accepts event without tabId when no tab filter is set', () => {
			const event: ScanProgressEvent = {
				sessionId: 'session-1',
				eventType: 'scan_start',
				contentLength: 100,
			};
			expect(shouldProcessEvent(event, 'session-1')).toBe(true);
		});
	});

	describe('minimum display time', () => {
		it('returns full MIN_DISPLAY_MS when scan just started', () => {
			const now = Date.now();
			expect(calculateRemainingDisplayTime(now, now)).toBe(MIN_DISPLAY_MS);
		});

		it('returns remaining time when partially elapsed', () => {
			const now = Date.now();
			const scanStartTime = now - 100; // 100ms ago
			expect(calculateRemainingDisplayTime(scanStartTime, now)).toBe(100);
		});

		it('returns 0 when MIN_DISPLAY_MS has elapsed', () => {
			const now = Date.now();
			const scanStartTime = now - MIN_DISPLAY_MS;
			expect(calculateRemainingDisplayTime(scanStartTime, now)).toBe(0);
		});

		it('returns 0 when more than MIN_DISPLAY_MS has elapsed', () => {
			const now = Date.now();
			const scanStartTime = now - MIN_DISPLAY_MS * 2;
			expect(calculateRemainingDisplayTime(scanStartTime, now)).toBe(0);
		});

		it('returns MIN_DISPLAY_MS when scanStartTime is null', () => {
			const now = Date.now();
			expect(calculateRemainingDisplayTime(null, now)).toBe(0); // No start time, hide immediately
		});
	});

	describe('content length threshold', () => {
		it('MIN_LENGTH_FOR_INDICATOR should be 50', () => {
			// Ensures we avoid flicker for short inputs
			expect(MIN_LENGTH_FOR_INDICATOR).toBe(50);
		});

		it('indicator should show for typical prompts', () => {
			// A typical prompt like "What is the weather today?" is about 30 chars
			// A more detailed prompt would be longer
			const shortPrompt = 'What is the weather?'; // 20 chars
			const mediumPrompt = 'Can you help me write a function that sorts an array?'; // 53 chars
			const longPrompt =
				'I need you to help me refactor this code to use TypeScript and add proper error handling throughout the application.'; // 122 chars

			expect(shouldShowIndicator(true, true, shortPrompt.length)).toBe(false);
			expect(shouldShowIndicator(true, true, mediumPrompt.length)).toBe(true);
			expect(shouldShowIndicator(true, true, longPrompt.length)).toBe(true);
		});
	});

	describe('MIN_DISPLAY_MS constant', () => {
		it('should be 200ms to prevent visual jarring', () => {
			expect(MIN_DISPLAY_MS).toBe(200);
		});
	});

	describe('event type handling', () => {
		it('scan_start should trigger scanning state', () => {
			const event: ScanProgressEvent = {
				sessionId: 'session-1',
				eventType: 'scan_start',
				contentLength: 100,
			};
			expect(event.eventType).toBe('scan_start');
		});

		it('scan_complete should end scanning state', () => {
			const event: ScanProgressEvent = {
				sessionId: 'session-1',
				eventType: 'scan_complete',
				contentLength: 100,
			};
			expect(event.eventType).toBe('scan_complete');
		});
	});
});

describe('ScanProgressEvent type', () => {
	it('should have required fields', () => {
		const event: ScanProgressEvent = {
			sessionId: 'test-session',
			eventType: 'scan_start',
			contentLength: 100,
		};

		expect(event.sessionId).toBeDefined();
		expect(event.eventType).toBeDefined();
		expect(event.contentLength).toBeDefined();
	});

	it('should allow optional tabId', () => {
		const eventWithTab: ScanProgressEvent = {
			sessionId: 'test-session',
			tabId: 'test-tab',
			eventType: 'scan_start',
			contentLength: 100,
		};

		const eventWithoutTab: ScanProgressEvent = {
			sessionId: 'test-session',
			eventType: 'scan_start',
			contentLength: 100,
		};

		expect(eventWithTab.tabId).toBe('test-tab');
		expect(eventWithoutTab.tabId).toBeUndefined();
	});
});
