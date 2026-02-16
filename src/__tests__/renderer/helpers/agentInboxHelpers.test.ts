/**
 * Tests for Agent Inbox helper functions
 *
 * Covers:
 * - formatRelativeTime (9 test cases)
 * - generateSmartSummary (5 test cases)
 * - resolveContextUsageColor (3 test cases)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatRelativeTime } from '../../../shared/formatters';
import { generateSmartSummary } from '../../../renderer/hooks/useAgentInbox';
import { resolveContextUsageColor } from '../../../renderer/components/AgentInbox';
import type { Theme } from '../../../renderer/types';

// ==========================================================================
// Minimal theme stub for resolveContextUsageColor tests
// ==========================================================================
const mockTheme = {
	colors: {
		success: '#00ff00',
		warning: '#ffaa00',
		error: '#ff0000',
	},
} as unknown as Theme;

// ==========================================================================
// formatRelativeTime tests
// ==========================================================================
describe('Agent Inbox helpers: formatRelativeTime', () => {
	let realDateNow: () => number;

	beforeEach(() => {
		realDateNow = Date.now;
	});

	afterEach(() => {
		Date.now = realDateNow;
	});

	it('1. returns "just now" for timestamps < 60s ago', () => {
		const now = Date.now();
		expect(formatRelativeTime(now - 10_000)).toBe('just now');
		expect(formatRelativeTime(now - 59_000)).toBe('just now');
	});

	it('2. returns "2m ago" for 120 seconds ago', () => {
		const now = Date.now();
		expect(formatRelativeTime(now - 120_000)).toBe('2m ago');
	});

	it('3. returns "1h ago" for 3600 seconds ago', () => {
		const now = Date.now();
		expect(formatRelativeTime(now - 3_600_000)).toBe('1h ago');
	});

	it('4. returns "yesterday" for 1 day ago', () => {
		const now = Date.now();
		expect(formatRelativeTime(now - 86_400_000)).toBe('yesterday');
	});

	it('5. returns "5d ago" for 5 days ago', () => {
		const now = Date.now();
		expect(formatRelativeTime(now - 5 * 86_400_000)).toBe('5d ago');
	});

	it('6. returns "\u2014" for 0 timestamp', () => {
		expect(formatRelativeTime(0)).toBe('\u2014');
	});

	it('7. returns "\u2014" for NaN timestamp', () => {
		expect(formatRelativeTime(NaN)).toBe('\u2014');
	});

	it('8. returns "\u2014" for negative timestamp', () => {
		expect(formatRelativeTime(-1)).toBe('\u2014');
		expect(formatRelativeTime(-999999)).toBe('\u2014');
	});

	it('9. returns "just now" for future timestamp (clock skew)', () => {
		const now = Date.now();
		expect(formatRelativeTime(now + 60_000)).toBe('just now');
	});
});

// ==========================================================================
// generateSmartSummary tests
// ==========================================================================
describe('Agent Inbox helpers: generateSmartSummary', () => {
	it('10. waiting_input state → prefixed with "Waiting: "', () => {
		const logs = [
			{ id: 'l1', timestamp: 1000, source: 'ai' as const, text: 'Please confirm the changes' },
		];
		const result = generateSmartSummary(logs, 'waiting_input');
		expect(result).toBe('Waiting: Please confirm the changes');
	});

	it('11. AI message ending with "?" → shown as question', () => {
		const logs = [
			{ id: 'l1', timestamp: 1000, source: 'ai' as const, text: 'Which file should I modify?' },
		];
		const result = generateSmartSummary(logs, 'idle');
		expect(result).toBe('Which file should I modify?');
	});

	it('12. AI statement → prefixed with "Done: "', () => {
		const logs = [
			{ id: 'l1', timestamp: 1000, source: 'ai' as const, text: 'I have updated the configuration file.' },
		];
		const result = generateSmartSummary(logs, 'idle');
		expect(result).toBe('Done: I have updated the configuration file.');
	});

	it('13. Empty logs → "No activity yet"', () => {
		expect(generateSmartSummary([], 'idle')).toBe('No activity yet');
		expect(generateSmartSummary(undefined, 'idle')).toBe('No activity yet');
	});

	it('14. Summary truncated at 90 chars with "..."', () => {
		const longText = 'A'.repeat(100) + '?';
		const logs = [
			{ id: 'l1', timestamp: 1000, source: 'ai' as const, text: longText },
		];
		const result = generateSmartSummary(logs, 'idle');
		expect(result.length).toBe(93); // 90 chars + '...'
		expect(result.endsWith('...')).toBe(true);
	});
});

// ==========================================================================
// resolveContextUsageColor tests
// ==========================================================================
describe('Agent Inbox helpers: resolveContextUsageColor', () => {
	it('15. 0-60% → returns green/success color', () => {
		expect(resolveContextUsageColor(0, mockTheme)).toBe(mockTheme.colors.success);
		expect(resolveContextUsageColor(30, mockTheme)).toBe(mockTheme.colors.success);
		expect(resolveContextUsageColor(59, mockTheme)).toBe(mockTheme.colors.success);
	});

	it('16. 60-80% → returns orange/warning color (NOT red)', () => {
		expect(resolveContextUsageColor(60, mockTheme)).toBe(mockTheme.colors.warning);
		expect(resolveContextUsageColor(70, mockTheme)).toBe(mockTheme.colors.warning);
		expect(resolveContextUsageColor(79, mockTheme)).toBe(mockTheme.colors.warning);
	});

	it('17. 80-100% → returns red/error color', () => {
		expect(resolveContextUsageColor(80, mockTheme)).toBe(mockTheme.colors.error);
		expect(resolveContextUsageColor(90, mockTheme)).toBe(mockTheme.colors.error);
		expect(resolveContextUsageColor(100, mockTheme)).toBe(mockTheme.colors.error);
	});
});
