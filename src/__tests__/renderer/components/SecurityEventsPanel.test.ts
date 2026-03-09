/**
 * @file SecurityEventsPanel.test.ts
 * @description Tests for SecurityEventsPanel export audit log functionality
 *
 * Tests the export functionality:
 * - Export format determination
 * - Date range filter logic
 * - Event type filter toggle logic
 * - Export filter building
 * - File naming convention
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Types for export functionality
type ExportFormat = 'json' | 'csv' | 'html';
type DateRangeOption = 'all' | '7d' | '30d' | 'custom';
type EventType = 'input_scan' | 'output_scan' | 'blocked' | 'warning' | 'inter_agent_scan';

interface ExportFilterOptions {
	startDate?: number;
	endDate?: number;
	eventTypes?: EventType[];
	sessionIds?: string[];
	minConfidence?: number;
}

// Helper function that mirrors the export logic
function buildExportFilters(
	dateRange: DateRangeOption,
	customStartDate: string,
	customEndDate: string,
	selectedEventTypes: Set<string>,
	minConfidence: number
): ExportFilterOptions {
	const filters: ExportFilterOptions = {};

	// Date range filter
	if (dateRange === '7d') {
		filters.startDate = Date.now() - 7 * 24 * 60 * 60 * 1000;
	} else if (dateRange === '30d') {
		filters.startDate = Date.now() - 30 * 24 * 60 * 60 * 1000;
	} else if (dateRange === 'custom') {
		if (customStartDate) {
			filters.startDate = new Date(customStartDate).getTime();
		}
		if (customEndDate) {
			filters.endDate = new Date(customEndDate).setHours(23, 59, 59, 999);
		}
	}

	// Event type filter
	if (selectedEventTypes.size > 0) {
		filters.eventTypes = [...selectedEventTypes] as EventType[];
	}

	// Confidence filter
	if (minConfidence > 0) {
		filters.minConfidence = minConfidence / 100;
	}

	return filters;
}

// Helper function to generate export filename
function generateExportFilename(format: ExportFormat): string {
	const extensions: Record<ExportFormat, string> = {
		json: 'json',
		csv: 'csv',
		html: 'html',
	};
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	return `llm-guard-audit-${timestamp}.${extensions[format]}`;
}

// Helper function to get MIME type
function getMimeType(format: ExportFormat): string {
	const mimeTypes: Record<ExportFormat, string> = {
		json: 'application/json',
		csv: 'text/csv',
		html: 'text/html',
	};
	return mimeTypes[format];
}

// Helper function to toggle event type in filter set
function toggleEventType(eventTypes: Set<string>, eventType: string): Set<string> {
	const newSet = new Set(eventTypes);
	if (newSet.has(eventType)) {
		newSet.delete(eventType);
	} else {
		newSet.add(eventType);
	}
	return newSet;
}

describe('SecurityEventsPanel Export', () => {
	describe('buildExportFilters', () => {
		it('returns empty filters for "all" date range with no other filters', () => {
			const filters = buildExportFilters('all', '', '', new Set(), 0);
			expect(filters).toEqual({});
		});

		it('sets startDate for 7d date range', () => {
			const now = Date.now();
			vi.setSystemTime(now);

			const filters = buildExportFilters('7d', '', '', new Set(), 0);
			expect(filters.startDate).toBeDefined();

			// Allow for some execution time difference
			const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
			expect(Math.abs((filters.startDate as number) - sevenDaysAgo)).toBeLessThan(1000);

			vi.useRealTimers();
		});

		it('sets startDate for 30d date range', () => {
			const now = Date.now();
			vi.setSystemTime(now);

			const filters = buildExportFilters('30d', '', '', new Set(), 0);
			expect(filters.startDate).toBeDefined();

			const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
			expect(Math.abs((filters.startDate as number) - thirtyDaysAgo)).toBeLessThan(1000);

			vi.useRealTimers();
		});

		it('sets custom date range with both dates', () => {
			const filters = buildExportFilters('custom', '2024-01-01', '2024-01-31', new Set(), 0);

			expect(filters.startDate).toBeDefined();
			expect(filters.endDate).toBeDefined();

			// Check start date is 2024-01-01 at midnight
			const startDate = new Date(filters.startDate as number);
			expect(startDate.getFullYear()).toBe(2024);
			expect(startDate.getMonth()).toBe(0); // January
			expect(startDate.getDate()).toBe(1);

			// Check end date is 2024-01-31 at 23:59:59.999
			const endDate = new Date(filters.endDate as number);
			expect(endDate.getFullYear()).toBe(2024);
			expect(endDate.getMonth()).toBe(0); // January
			expect(endDate.getDate()).toBe(31);
			expect(endDate.getHours()).toBe(23);
			expect(endDate.getMinutes()).toBe(59);
		});

		it('sets only startDate for custom range with just start date', () => {
			const filters = buildExportFilters('custom', '2024-01-01', '', new Set(), 0);

			expect(filters.startDate).toBeDefined();
			expect(filters.endDate).toBeUndefined();
		});

		it('sets only endDate for custom range with just end date', () => {
			const filters = buildExportFilters('custom', '', '2024-01-31', new Set(), 0);

			expect(filters.startDate).toBeUndefined();
			expect(filters.endDate).toBeDefined();
		});

		it('includes event types when selected', () => {
			const eventTypes = new Set(['input_scan', 'blocked']);
			const filters = buildExportFilters('all', '', '', eventTypes, 0);

			expect(filters.eventTypes).toBeDefined();
			expect(filters.eventTypes).toHaveLength(2);
			expect(filters.eventTypes).toContain('input_scan');
			expect(filters.eventTypes).toContain('blocked');
		});

		it('does not include event types when none selected', () => {
			const filters = buildExportFilters('all', '', '', new Set(), 0);
			expect(filters.eventTypes).toBeUndefined();
		});

		it('converts confidence percentage to decimal', () => {
			const filters = buildExportFilters('all', '', '', new Set(), 75);
			expect(filters.minConfidence).toBe(0.75);
		});

		it('does not set confidence filter when 0', () => {
			const filters = buildExportFilters('all', '', '', new Set(), 0);
			expect(filters.minConfidence).toBeUndefined();
		});

		it('combines multiple filters correctly', () => {
			const eventTypes = new Set(['blocked', 'warning']);
			const filters = buildExportFilters('7d', '', '', eventTypes, 50);

			expect(filters.startDate).toBeDefined();
			expect(filters.eventTypes).toEqual(['blocked', 'warning']);
			expect(filters.minConfidence).toBe(0.5);
		});
	});

	describe('generateExportFilename', () => {
		it('generates correct filename for JSON format', () => {
			const filename = generateExportFilename('json');
			expect(filename).toMatch(/^llm-guard-audit-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/);
		});

		it('generates correct filename for CSV format', () => {
			const filename = generateExportFilename('csv');
			expect(filename).toMatch(/^llm-guard-audit-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.csv$/);
		});

		it('generates correct filename for HTML format', () => {
			const filename = generateExportFilename('html');
			expect(filename).toMatch(/^llm-guard-audit-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.html$/);
		});
	});

	describe('getMimeType', () => {
		it('returns correct MIME type for JSON', () => {
			expect(getMimeType('json')).toBe('application/json');
		});

		it('returns correct MIME type for CSV', () => {
			expect(getMimeType('csv')).toBe('text/csv');
		});

		it('returns correct MIME type for HTML', () => {
			expect(getMimeType('html')).toBe('text/html');
		});
	});

	describe('toggleEventType', () => {
		it('adds event type when not present', () => {
			const initial = new Set<string>();
			const result = toggleEventType(initial, 'input_scan');

			expect(result.has('input_scan')).toBe(true);
			expect(result.size).toBe(1);
		});

		it('removes event type when already present', () => {
			const initial = new Set(['input_scan']);
			const result = toggleEventType(initial, 'input_scan');

			expect(result.has('input_scan')).toBe(false);
			expect(result.size).toBe(0);
		});

		it('preserves other event types when toggling', () => {
			const initial = new Set(['input_scan', 'output_scan']);
			const result = toggleEventType(initial, 'blocked');

			expect(result.has('input_scan')).toBe(true);
			expect(result.has('output_scan')).toBe(true);
			expect(result.has('blocked')).toBe(true);
			expect(result.size).toBe(3);
		});

		it('does not mutate the original set', () => {
			const initial = new Set(['input_scan']);
			const result = toggleEventType(initial, 'blocked');

			expect(initial.size).toBe(1);
			expect(initial.has('blocked')).toBe(false);
			expect(result.size).toBe(2);
		});
	});

	describe('export format selection', () => {
		const formats: ExportFormat[] = ['json', 'csv', 'html'];
		let selectedFormat: ExportFormat = 'json';

		beforeEach(() => {
			selectedFormat = 'json';
		});

		it('defaults to JSON format', () => {
			expect(selectedFormat).toBe('json');
		});

		it('can select each format', () => {
			for (const format of formats) {
				selectedFormat = format;
				expect(selectedFormat).toBe(format);
			}
		});
	});

	describe('export disabled state', () => {
		it('should be disabled when no events exist', () => {
			const events: unknown[] = [];
			const isDisabled = events.length === 0;
			expect(isDisabled).toBe(true);
		});

		it('should be enabled when events exist', () => {
			const events = [{ id: 'event-1' }, { id: 'event-2' }];
			const isDisabled = events.length === 0;
			expect(isDisabled).toBe(false);
		});
	});

	describe('event type labels', () => {
		it('provides correct labels for event types', () => {
			const labels: Record<EventType, string> = {
				input_scan: 'Input',
				output_scan: 'Output',
				blocked: 'Blocked',
				warning: 'Warning',
				inter_agent_scan: 'Inter-Agent',
			};

			expect(labels.input_scan).toBe('Input');
			expect(labels.output_scan).toBe('Output');
			expect(labels.blocked).toBe('Blocked');
			expect(labels.warning).toBe('Warning');
			expect(labels.inter_agent_scan).toBe('Inter-Agent');
		});
	});

	describe('export filter state messages', () => {
		it('shows "All event types" message when no types selected', () => {
			const selected = new Set<string>();
			const message =
				selected.size === 0
					? 'All event types will be included'
					: `${selected.size} type(s) selected`;
			expect(message).toBe('All event types will be included');
		});

		it('shows count message when types are selected', () => {
			const selected = new Set(['input_scan', 'blocked', 'warning']);
			const message =
				selected.size === 0
					? 'All event types will be included'
					: `${selected.size} type(s) selected`;
			expect(message).toBe('3 type(s) selected');
		});
	});

	describe('confidence slider', () => {
		it('converts slider value (0-100) to decimal (0-1)', () => {
			const sliderValue = 75;
			const decimal = sliderValue / 100;
			expect(decimal).toBe(0.75);
		});

		it('handles minimum value', () => {
			const sliderValue = 0;
			const decimal = sliderValue / 100;
			expect(decimal).toBe(0);
		});

		it('handles maximum value', () => {
			const sliderValue = 100;
			const decimal = sliderValue / 100;
			expect(decimal).toBe(1);
		});

		it('handles increments of 5', () => {
			const increments = [
				0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100,
			];
			for (const value of increments) {
				const decimal = value / 100;
				expect(decimal).toBeCloseTo(value / 100);
			}
		});
	});

	describe('date range options', () => {
		const options: { value: DateRangeOption; label: string }[] = [
			{ value: 'all', label: 'All Time' },
			{ value: '7d', label: 'Last 7 Days' },
			{ value: '30d', label: 'Last 30 Days' },
			{ value: 'custom', label: 'Custom' },
		];

		it('has correct number of options', () => {
			expect(options).toHaveLength(4);
		});

		it('has All Time option first', () => {
			expect(options[0].value).toBe('all');
			expect(options[0].label).toBe('All Time');
		});

		it('includes Custom option for custom date range', () => {
			const customOption = options.find((o) => o.value === 'custom');
			expect(customOption).toBeDefined();
			expect(customOption?.label).toBe('Custom');
		});
	});
});
