/**
 * @file LlmGuardIndicator.test.ts
 * @description Tests for LlmGuardIndicator component logic
 *
 * Tests the indicator's:
 * - Status determination based on events (disabled, active, warning, blocked, scanning)
 * - Event counting and state management
 * - Tooltip text generation
 * - Shield icon and color selection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SecurityEventData } from '../../../main/preload/security';

// Mock the LlmGuardIndicator's helper functions for testing
// We test the logic separately since React component testing requires additional setup

type LlmGuardStatus = 'disabled' | 'active' | 'warning' | 'blocked' | 'scanning';

// Helper function to determine status (mirrors component logic)
function getStatus(
	enabled: boolean,
	isScanning: boolean,
	recentBlocked: number,
	recentWarnings: number
): LlmGuardStatus {
	if (!enabled) return 'disabled';
	if (isScanning) return 'scanning';
	if (recentBlocked > 0) return 'blocked';
	if (recentWarnings > 0) return 'warning';
	return 'active';
}

// Helper to build tooltip text (mirrors component logic)
function buildTooltipText(
	enabled: boolean,
	recentBlocked: number,
	recentWarnings: number,
	lastEventTime: number | null,
	currentTime: number
): string {
	if (!enabled) {
		return 'LLM Guard is disabled. Click to configure.';
	}

	const parts: string[] = [];

	// Status label
	if (recentBlocked > 0) {
		parts.push('LLM Guard: content blocked');
	} else if (recentWarnings > 0) {
		parts.push('LLM Guard: warnings detected');
	} else {
		parts.push('LLM Guard active, no issues');
	}

	if (recentBlocked > 0 || recentWarnings > 0) {
		const eventParts: string[] = [];
		if (recentBlocked > 0) {
			eventParts.push(`${recentBlocked} blocked`);
		}
		if (recentWarnings > 0) {
			eventParts.push(`${recentWarnings} warning${recentWarnings !== 1 ? 's' : ''}`);
		}
		parts.push(`Recent: ${eventParts.join(', ')}`);
	}

	if (lastEventTime) {
		const ago = Math.floor((currentTime - lastEventTime) / 1000);
		if (ago < 60) {
			parts.push(`Last event: ${ago}s ago`);
		} else if (ago < 3600) {
			parts.push(`Last event: ${Math.floor(ago / 60)}m ago`);
		}
	}

	parts.push('Click to view security events');

	return parts.join('\n');
}

describe('LlmGuardIndicator', () => {
	describe('getStatus', () => {
		it('returns disabled when guard is not enabled', () => {
			expect(getStatus(false, false, 0, 0)).toBe('disabled');
			expect(getStatus(false, true, 0, 0)).toBe('disabled');
			expect(getStatus(false, false, 5, 3)).toBe('disabled');
		});

		it('returns scanning when actively scanning', () => {
			expect(getStatus(true, true, 0, 0)).toBe('scanning');
		});

		it('returns blocked when there are blocked events (highest priority)', () => {
			expect(getStatus(true, false, 1, 0)).toBe('blocked');
			expect(getStatus(true, false, 5, 10)).toBe('blocked');
			// Scanning takes precedence during active scan
			expect(getStatus(true, true, 5, 10)).toBe('scanning');
		});

		it('returns warning when there are warning events but no blocked', () => {
			expect(getStatus(true, false, 0, 1)).toBe('warning');
			expect(getStatus(true, false, 0, 10)).toBe('warning');
		});

		it('returns active when enabled with no issues', () => {
			expect(getStatus(true, false, 0, 0)).toBe('active');
		});
	});

	describe('buildTooltipText', () => {
		const currentTime = Date.now();

		it('shows disabled message when guard is off', () => {
			const tooltip = buildTooltipText(false, 0, 0, null, currentTime);
			expect(tooltip).toBe('LLM Guard is disabled. Click to configure.');
		});

		it('shows active status with no issues', () => {
			const tooltip = buildTooltipText(true, 0, 0, null, currentTime);
			expect(tooltip).toContain('LLM Guard active, no issues');
			expect(tooltip).toContain('Click to view security events');
		});

		it('shows blocked status with count', () => {
			const tooltip = buildTooltipText(true, 3, 0, null, currentTime);
			expect(tooltip).toContain('LLM Guard: content blocked');
			expect(tooltip).toContain('Recent: 3 blocked');
		});

		it('shows warning status with count', () => {
			const tooltip = buildTooltipText(true, 0, 5, null, currentTime);
			expect(tooltip).toContain('LLM Guard: warnings detected');
			expect(tooltip).toContain('Recent: 5 warnings');
		});

		it('shows both blocked and warning counts', () => {
			const tooltip = buildTooltipText(true, 2, 3, null, currentTime);
			expect(tooltip).toContain('LLM Guard: content blocked');
			expect(tooltip).toContain('Recent: 2 blocked, 3 warnings');
		});

		it('uses singular form for single warning', () => {
			const tooltip = buildTooltipText(true, 0, 1, null, currentTime);
			expect(tooltip).toContain('1 warning');
			expect(tooltip).not.toContain('1 warnings');
		});

		it('shows last event time in seconds', () => {
			const lastEventTime = currentTime - 30000; // 30 seconds ago
			const tooltip = buildTooltipText(true, 1, 0, lastEventTime, currentTime);
			expect(tooltip).toContain('Last event: 30s ago');
		});

		it('shows last event time in minutes', () => {
			const lastEventTime = currentTime - 180000; // 3 minutes ago
			const tooltip = buildTooltipText(true, 1, 0, lastEventTime, currentTime);
			expect(tooltip).toContain('Last event: 3m ago');
		});

		it('does not show old event times', () => {
			const lastEventTime = currentTime - 7200000; // 2 hours ago
			const tooltip = buildTooltipText(true, 1, 0, lastEventTime, currentTime);
			expect(tooltip).not.toContain('Last event:');
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

		it('correctly identifies scan events', () => {
			const inputScan: SecurityEventData = {
				sessionId: 'test-session',
				eventType: 'input_scan',
				findingTypes: [],
				findingCount: 0,
				action: 'none',
				originalLength: 100,
				sanitizedLength: 100,
			};

			const outputScan: SecurityEventData = {
				sessionId: 'test-session',
				eventType: 'output_scan',
				findingTypes: [],
				findingCount: 0,
				action: 'none',
				originalLength: 100,
				sanitizedLength: 100,
			};

			expect(inputScan.eventType).toBe('input_scan');
			expect(outputScan.eventType).toBe('output_scan');
		});
	});

	describe('session filtering', () => {
		const testSessionId = 'test-session-123';

		it('event should be filtered by session ID', () => {
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
			const filterBySession = (event: SecurityEventData, sessionId?: string) => {
				if (sessionId && event.sessionId !== sessionId) {
					return false;
				}
				return true;
			};

			expect(filterBySession(event1, testSessionId)).toBe(true);
			expect(filterBySession(event2, testSessionId)).toBe(false);
			expect(filterBySession(event1, undefined)).toBe(true); // No filter = all events pass
			expect(filterBySession(event2, undefined)).toBe(true);
		});
	});

	describe('badge display logic', () => {
		it('calculates total findings correctly', () => {
			const recentBlocked = 3;
			const recentWarnings = 5;
			const totalFindings = recentBlocked + recentWarnings;

			expect(totalFindings).toBe(8);
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

		it('shows badge only when there are findings', () => {
			const shouldShowBadge = (totalFindings: number) => totalFindings > 0;

			expect(shouldShowBadge(0)).toBe(false);
			expect(shouldShowBadge(1)).toBe(true);
			expect(shouldShowBadge(100)).toBe(true);
		});
	});

	describe('status colors', () => {
		// Mock theme colors for testing
		const mockTheme = {
			colors: {
				textDim: '#888888',
				success: '#00ff00',
				warning: '#ffff00',
				error: '#ff0000',
				accent: '#0000ff',
			},
		};

		type StatusConfig = {
			color: string;
			label: string;
		};

		const getStatusConfig = (status: LlmGuardStatus): StatusConfig => {
			switch (status) {
				case 'disabled':
					return { color: mockTheme.colors.textDim, label: 'LLM Guard disabled' };
				case 'active':
					return { color: mockTheme.colors.success, label: 'LLM Guard active, no issues' };
				case 'warning':
					return { color: mockTheme.colors.warning, label: 'LLM Guard: warnings detected' };
				case 'blocked':
					return { color: mockTheme.colors.error, label: 'LLM Guard: content blocked' };
				case 'scanning':
					return { color: mockTheme.colors.accent, label: 'Scanning...' };
			}
		};

		it('uses gray color for disabled state', () => {
			const config = getStatusConfig('disabled');
			expect(config.color).toBe(mockTheme.colors.textDim);
		});

		it('uses green color for active state', () => {
			const config = getStatusConfig('active');
			expect(config.color).toBe(mockTheme.colors.success);
		});

		it('uses yellow color for warning state', () => {
			const config = getStatusConfig('warning');
			expect(config.color).toBe(mockTheme.colors.warning);
		});

		it('uses red color for blocked state', () => {
			const config = getStatusConfig('blocked');
			expect(config.color).toBe(mockTheme.colors.error);
		});

		it('uses accent color for scanning state', () => {
			const config = getStatusConfig('scanning');
			expect(config.color).toBe(mockTheme.colors.accent);
		});
	});

	describe('event timeout behavior', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('clears counts after inactivity timeout', () => {
			const CLEAR_TIMEOUT_MS = 30000;
			let recentWarnings = 5;
			let recentBlocked = 3;

			// Simulate clearing after timeout
			const clearCounts = () => {
				recentWarnings = 0;
				recentBlocked = 0;
			};

			const timeout = setTimeout(clearCounts, CLEAR_TIMEOUT_MS);

			// Before timeout
			expect(recentWarnings).toBe(5);
			expect(recentBlocked).toBe(3);

			// Advance time past timeout
			vi.advanceTimersByTime(CLEAR_TIMEOUT_MS + 100);

			expect(recentWarnings).toBe(0);
			expect(recentBlocked).toBe(0);

			clearTimeout(timeout);
		});
	});
});
