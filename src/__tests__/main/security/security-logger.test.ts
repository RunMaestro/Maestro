import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mock electron app module before importing the security logger
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn().mockReturnValue('/tmp/maestro-test'),
	},
}));

// Import after mocking
import {
	logSecurityEvent,
	getRecentEvents,
	getAllEvents,
	getEventsByType,
	getEventsBySession,
	clearEvents,
	clearAllEvents,
	subscribeToEvents,
	getEventStats,
	loadEventsFromFile,
	exportToJson,
	exportToCsv,
	exportToHtml,
	exportSecurityEvents,
	getUniqueSessionIds,
	MAX_EVENTS,
	type SecurityEvent,
	type SecurityEventParams,
	type ExportFilterOptions,
} from '../../../main/security/security-logger';

// Mock fs module
vi.mock('fs/promises', () => ({
	appendFile: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockResolvedValue(''),
}));

describe('security-logger', () => {
	beforeEach(() => {
		// Clear events before each test
		clearEvents();
		vi.clearAllMocks();
	});

	afterEach(() => {
		clearEvents();
	});

	describe('logSecurityEvent', () => {
		it('logs an event with auto-generated id and timestamp', async () => {
			const params: SecurityEventParams = {
				sessionId: 'test-session-1',
				eventType: 'input_scan',
				findings: [
					{ type: 'PII_EMAIL', value: 'test@example.com', start: 0, end: 16, confidence: 0.99 },
				],
				action: 'sanitized',
				originalLength: 100,
				sanitizedLength: 90,
			};

			const event = await logSecurityEvent(params, false);

			expect(event.id).toBeDefined();
			expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
			expect(event.timestamp).toBeGreaterThan(0);
			expect(event.sessionId).toBe('test-session-1');
			expect(event.eventType).toBe('input_scan');
			expect(event.findings).toHaveLength(1);
			expect(event.action).toBe('sanitized');
		});

		it('persists event to file when requested', async () => {
			const params: SecurityEventParams = {
				sessionId: 'test-session-1',
				eventType: 'input_scan',
				findings: [],
				action: 'none',
				originalLength: 50,
				sanitizedLength: 50,
			};

			await logSecurityEvent(params, true);

			expect(fs.appendFile).toHaveBeenCalled();
		});

		it('does not persist to file when disabled', async () => {
			const params: SecurityEventParams = {
				sessionId: 'test-session-1',
				eventType: 'input_scan',
				findings: [],
				action: 'none',
				originalLength: 50,
				sanitizedLength: 50,
			};

			await logSecurityEvent(params, false);

			expect(fs.appendFile).not.toHaveBeenCalled();
		});
	});

	describe('circular buffer', () => {
		it('stores events up to MAX_EVENTS', async () => {
			// Log MAX_EVENTS events
			for (let i = 0; i < MAX_EVENTS; i++) {
				await logSecurityEvent(
					{
						sessionId: `session-${i}`,
						eventType: 'input_scan',
						findings: [],
						action: 'none',
						originalLength: 10,
						sanitizedLength: 10,
					},
					false
				);
			}

			const stats = getEventStats();
			expect(stats.bufferSize).toBe(MAX_EVENTS);
		});

		it('overwrites oldest events when buffer is full', async () => {
			// Log MAX_EVENTS + 10 events
			const extraEvents = 10;
			for (let i = 0; i < MAX_EVENTS + extraEvents; i++) {
				await logSecurityEvent(
					{
						sessionId: `session-${i}`,
						eventType: 'input_scan',
						findings: [],
						action: 'none',
						originalLength: 10,
						sanitizedLength: 10,
					},
					false
				);
			}

			const stats = getEventStats();
			expect(stats.bufferSize).toBe(MAX_EVENTS);
			expect(stats.totalLogged).toBe(MAX_EVENTS + extraEvents);

			// The first 10 events should have been overwritten
			const events = getAllEvents();
			const sessionIds = events.map((e) => e.sessionId);
			expect(sessionIds).not.toContain('session-0');
			expect(sessionIds).not.toContain('session-9');
			expect(sessionIds).toContain(`session-${MAX_EVENTS}`);
			expect(sessionIds).toContain(`session-${MAX_EVENTS + extraEvents - 1}`);
		});
	});

	describe('getRecentEvents', () => {
		it('returns events sorted by timestamp descending', async () => {
			for (let i = 0; i < 5; i++) {
				await logSecurityEvent(
					{
						sessionId: `session-${i}`,
						eventType: 'input_scan',
						findings: [],
						action: 'none',
						originalLength: 10,
						sanitizedLength: 10,
					},
					false
				);
				// Small delay to ensure different timestamps
				await new Promise((resolve) => setTimeout(resolve, 5));
			}

			const page = getRecentEvents(10, 0);
			expect(page.events).toHaveLength(5);
			expect(page.total).toBe(5);
			expect(page.hasMore).toBe(false);

			// Most recent should be first
			expect(page.events[0].sessionId).toBe('session-4');
			expect(page.events[4].sessionId).toBe('session-0');
		});

		it('supports pagination', async () => {
			for (let i = 0; i < 10; i++) {
				await logSecurityEvent(
					{
						sessionId: `session-${i}`,
						eventType: 'input_scan',
						findings: [],
						action: 'none',
						originalLength: 10,
						sanitizedLength: 10,
					},
					false
				);
			}

			const page1 = getRecentEvents(3, 0);
			expect(page1.events).toHaveLength(3);
			expect(page1.total).toBe(10);
			expect(page1.hasMore).toBe(true);

			const page2 = getRecentEvents(3, 3);
			expect(page2.events).toHaveLength(3);
			expect(page2.hasMore).toBe(true);

			const page3 = getRecentEvents(3, 9);
			expect(page3.events).toHaveLength(1);
			expect(page3.hasMore).toBe(false);
		});
	});

	describe('getEventsByType', () => {
		it('filters events by type', async () => {
			await logSecurityEvent(
				{
					sessionId: 'session-1',
					eventType: 'input_scan',
					findings: [],
					action: 'none',
					originalLength: 10,
					sanitizedLength: 10,
				},
				false
			);
			await logSecurityEvent(
				{
					sessionId: 'session-2',
					eventType: 'blocked',
					findings: [],
					action: 'blocked',
					originalLength: 10,
					sanitizedLength: 10,
				},
				false
			);
			await logSecurityEvent(
				{
					sessionId: 'session-3',
					eventType: 'input_scan',
					findings: [],
					action: 'sanitized',
					originalLength: 10,
					sanitizedLength: 10,
				},
				false
			);

			const inputScans = getEventsByType('input_scan');
			expect(inputScans).toHaveLength(2);

			const blocked = getEventsByType('blocked');
			expect(blocked).toHaveLength(1);
			expect(blocked[0].sessionId).toBe('session-2');
		});
	});

	describe('getEventsBySession', () => {
		it('filters events by session', async () => {
			await logSecurityEvent(
				{
					sessionId: 'session-a',
					eventType: 'input_scan',
					findings: [],
					action: 'none',
					originalLength: 10,
					sanitizedLength: 10,
				},
				false
			);
			await logSecurityEvent(
				{
					sessionId: 'session-b',
					eventType: 'output_scan',
					findings: [],
					action: 'none',
					originalLength: 10,
					sanitizedLength: 10,
				},
				false
			);
			await logSecurityEvent(
				{
					sessionId: 'session-a',
					eventType: 'output_scan',
					findings: [],
					action: 'sanitized',
					originalLength: 10,
					sanitizedLength: 10,
				},
				false
			);

			const sessionAEvents = getEventsBySession('session-a');
			expect(sessionAEvents).toHaveLength(2);

			const sessionBEvents = getEventsBySession('session-b');
			expect(sessionBEvents).toHaveLength(1);
		});
	});

	describe('subscribeToEvents', () => {
		it('notifies listener when events are logged', async () => {
			const listener = vi.fn();
			const unsubscribe = subscribeToEvents(listener);

			await logSecurityEvent(
				{
					sessionId: 'session-1',
					eventType: 'input_scan',
					findings: [],
					action: 'none',
					originalLength: 10,
					sanitizedLength: 10,
				},
				false
			);

			expect(listener).toHaveBeenCalledTimes(1);
			expect(listener).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-1',
					eventType: 'input_scan',
				})
			);

			unsubscribe();
		});

		it('unsubscribes correctly', async () => {
			const listener = vi.fn();
			const unsubscribe = subscribeToEvents(listener);

			await logSecurityEvent(
				{
					sessionId: 'session-1',
					eventType: 'input_scan',
					findings: [],
					action: 'none',
					originalLength: 10,
					sanitizedLength: 10,
				},
				false
			);

			expect(listener).toHaveBeenCalledTimes(1);

			unsubscribe();

			await logSecurityEvent(
				{
					sessionId: 'session-2',
					eventType: 'input_scan',
					findings: [],
					action: 'none',
					originalLength: 10,
					sanitizedLength: 10,
				},
				false
			);

			// Should still be 1, not 2
			expect(listener).toHaveBeenCalledTimes(1);
		});
	});

	describe('clearEvents', () => {
		it('clears the buffer', async () => {
			await logSecurityEvent(
				{
					sessionId: 'session-1',
					eventType: 'input_scan',
					findings: [],
					action: 'none',
					originalLength: 10,
					sanitizedLength: 10,
				},
				false
			);

			expect(getAllEvents()).toHaveLength(1);

			clearEvents();

			expect(getAllEvents()).toHaveLength(0);
		});
	});

	describe('clearAllEvents', () => {
		it('clears buffer and writes empty file', async () => {
			await logSecurityEvent(
				{
					sessionId: 'session-1',
					eventType: 'input_scan',
					findings: [],
					action: 'none',
					originalLength: 10,
					sanitizedLength: 10,
				},
				false
			);

			await clearAllEvents();

			expect(getAllEvents()).toHaveLength(0);
			expect(fs.writeFile).toHaveBeenCalled();
		});
	});

	describe('loadEventsFromFile', () => {
		it('loads events from JSONL file', async () => {
			const mockEvents = [
				{
					id: 'id-1',
					timestamp: 1000,
					sessionId: 'session-1',
					eventType: 'input_scan',
					findings: [],
					action: 'none',
					originalLength: 10,
					sanitizedLength: 10,
				},
				{
					id: 'id-2',
					timestamp: 2000,
					sessionId: 'session-2',
					eventType: 'output_scan',
					findings: [],
					action: 'sanitized',
					originalLength: 20,
					sanitizedLength: 15,
				},
			];

			vi.mocked(fs.readFile).mockResolvedValue(mockEvents.map((e) => JSON.stringify(e)).join('\n'));

			const loaded = await loadEventsFromFile();

			expect(loaded).toBe(2);
			expect(getAllEvents()).toHaveLength(2);
		});

		it('handles empty file', async () => {
			vi.mocked(fs.readFile).mockResolvedValue('');

			const loaded = await loadEventsFromFile();

			expect(loaded).toBe(0);
		});

		it('handles non-existent file', async () => {
			const error = new Error('ENOENT') as NodeJS.ErrnoException;
			error.code = 'ENOENT';
			vi.mocked(fs.readFile).mockRejectedValue(error);

			const loaded = await loadEventsFromFile();

			expect(loaded).toBe(0);
		});

		it('skips malformed lines', async () => {
			const mockContent = [
				'{"id":"id-1","timestamp":1000,"sessionId":"s1","eventType":"input_scan","findings":[],"action":"none","originalLength":10,"sanitizedLength":10}',
				'invalid json line',
				'{"id":"id-2","timestamp":2000,"sessionId":"s2","eventType":"output_scan","findings":[],"action":"none","originalLength":10,"sanitizedLength":10}',
			].join('\n');

			vi.mocked(fs.readFile).mockResolvedValue(mockContent);

			const loaded = await loadEventsFromFile();

			expect(loaded).toBe(2);
		});
	});

	describe('getEventStats', () => {
		it('returns accurate statistics', async () => {
			const initialStats = getEventStats();
			expect(initialStats.bufferSize).toBe(0);
			expect(initialStats.totalLogged).toBe(0);
			expect(initialStats.maxSize).toBe(MAX_EVENTS);

			await logSecurityEvent(
				{
					sessionId: 'session-1',
					eventType: 'input_scan',
					findings: [],
					action: 'none',
					originalLength: 10,
					sanitizedLength: 10,
				},
				false
			);

			const afterStats = getEventStats();
			expect(afterStats.bufferSize).toBe(1);
			expect(afterStats.totalLogged).toBe(1);
		});
	});

	describe('export functionality', () => {
		beforeEach(async () => {
			// Create test events
			await logSecurityEvent(
				{
					sessionId: 'session-a',
					eventType: 'input_scan',
					findings: [
						{ type: 'PII_EMAIL', value: 'test@example.com', start: 0, end: 16, confidence: 0.95 },
					],
					action: 'sanitized',
					originalLength: 100,
					sanitizedLength: 90,
				},
				false
			);
			await logSecurityEvent(
				{
					sessionId: 'session-b',
					eventType: 'blocked',
					findings: [
						{
							type: 'PROMPT_INJECTION',
							value: 'ignore previous instructions',
							start: 0,
							end: 28,
							confidence: 0.85,
						},
					],
					action: 'blocked',
					originalLength: 50,
					sanitizedLength: 0,
				},
				false
			);
			await logSecurityEvent(
				{
					sessionId: 'session-a',
					eventType: 'output_scan',
					findings: [],
					action: 'none',
					originalLength: 200,
					sanitizedLength: 200,
				},
				false
			);
		});

		describe('exportToJson', () => {
			it('exports all events as valid JSON', () => {
				const json = exportToJson();
				const parsed = JSON.parse(json);

				expect(parsed.exportedAt).toBeDefined();
				expect(parsed.totalEvents).toBe(3);
				expect(parsed.events).toHaveLength(3);
				expect(parsed.filters).toBeDefined();
			});

			it('filters by event type', () => {
				const json = exportToJson({ eventTypes: ['blocked'] });
				const parsed = JSON.parse(json);

				expect(parsed.totalEvents).toBe(1);
				expect(parsed.events[0].eventType).toBe('blocked');
			});

			it('filters by session ID', () => {
				const json = exportToJson({ sessionIds: ['session-a'] });
				const parsed = JSON.parse(json);

				expect(parsed.totalEvents).toBe(2);
				parsed.events.forEach((e: SecurityEvent) => {
					expect(e.sessionId).toBe('session-a');
				});
			});

			it('filters by minimum confidence', () => {
				const json = exportToJson({ minConfidence: 0.9 });
				const parsed = JSON.parse(json);

				// Only events with findings having confidence >= 0.9
				expect(parsed.totalEvents).toBe(1);
				expect(parsed.events[0].findings[0].confidence).toBeGreaterThanOrEqual(0.9);
			});

			it('filters by date range', async () => {
				clearEvents();

				// Create event with old timestamp (simulate by direct buffer manipulation isn't possible,
				// so we test that filtering logic works)
				const now = Date.now();
				await logSecurityEvent(
					{
						sessionId: 'session-recent',
						eventType: 'input_scan',
						findings: [],
						action: 'none',
						originalLength: 10,
						sanitizedLength: 10,
					},
					false
				);

				const json = exportToJson({
					startDate: now - 1000,
					endDate: now + 1000,
				});
				const parsed = JSON.parse(json);

				expect(parsed.totalEvents).toBeGreaterThan(0);
			});
		});

		describe('exportToCsv', () => {
			it('exports as valid CSV format', () => {
				const csv = exportToCsv();
				const lines = csv.split('\n');

				// Should have header + 3 data rows
				expect(lines.length).toBe(4);

				// Check header
				const headers = lines[0].split(',');
				expect(headers).toContain('ID');
				expect(headers).toContain('Timestamp');
				expect(headers).toContain('Session ID');
				expect(headers).toContain('Event Type');
				expect(headers).toContain('Action');
				expect(headers).toContain('Finding Count');
			});

			it('escapes special characters in CSV fields', async () => {
				clearEvents();
				await logSecurityEvent(
					{
						sessionId: 'session-with,comma',
						eventType: 'input_scan',
						findings: [],
						action: 'none',
						originalLength: 10,
						sanitizedLength: 10,
					},
					false
				);

				const csv = exportToCsv();
				// Session ID with comma should be quoted
				expect(csv).toContain('"session-with,comma"');
			});

			it('applies filters correctly', () => {
				const csv = exportToCsv({ eventTypes: ['blocked'] });
				const lines = csv.split('\n');

				// Header + 1 filtered row
				expect(lines.length).toBe(2);
				expect(lines[1]).toContain('blocked');
			});
		});

		describe('exportToHtml', () => {
			it('generates valid HTML document', () => {
				const html = exportToHtml();

				expect(html).toContain('<!DOCTYPE html>');
				expect(html).toContain('<html');
				expect(html).toContain('</html>');
				expect(html).toContain('LLM Guard Security Audit Log');
			});

			it('includes statistics summary', () => {
				const html = exportToHtml();

				expect(html).toContain('Total Events');
				expect(html).toContain('Blocked');
				expect(html).toContain('Sanitized');
			});

			it('includes event details', () => {
				const html = exportToHtml();

				// Session IDs are truncated to first segment in UI (session-a → session)
				expect(html).toContain('session');
				expect(html).toContain('PII_EMAIL');
				expect(html).toContain('PROMPT_INJECTION');
				expect(html).toContain('input_scan');
				expect(html).toContain('output_scan');
				expect(html).toContain('blocked');
			});

			it('escapes HTML in event content', async () => {
				clearEvents();
				await logSecurityEvent(
					{
						sessionId: 'session-test',
						eventType: 'input_scan',
						findings: [
							{
								type: 'TEST',
								value: '<script>alert("xss")</script>',
								start: 0,
								end: 31,
								confidence: 0.9,
							},
						],
						action: 'sanitized',
						originalLength: 50,
						sanitizedLength: 40,
					},
					false
				);

				const html = exportToHtml();

				// Script tags should be escaped
				expect(html).not.toContain('<script>');
				expect(html).toContain('&lt;script&gt;');
			});

			it('applies filters and shows filter description', () => {
				const html = exportToHtml({ eventTypes: ['blocked'] });

				expect(html).toContain('Filters Applied');
				expect(html).toContain('blocked');
				// Only blocked events should be in the table
				expect(html).not.toContain('input_scan');
			});
		});

		describe('exportSecurityEvents', () => {
			it('routes to correct exporter based on format', () => {
				const jsonExport = exportSecurityEvents('json');
				expect(() => JSON.parse(jsonExport)).not.toThrow();

				const csvExport = exportSecurityEvents('csv');
				expect(csvExport.split('\n')[0]).toContain('ID');

				const htmlExport = exportSecurityEvents('html');
				expect(htmlExport).toContain('<!DOCTYPE html>');
			});

			it('throws for unsupported format', () => {
				expect(() => exportSecurityEvents('xml' as any)).toThrow('Unsupported export format');
			});

			it('passes filters to exporter', () => {
				const jsonExport = exportSecurityEvents('json', { eventTypes: ['blocked'] });
				const parsed = JSON.parse(jsonExport);

				expect(parsed.totalEvents).toBe(1);
			});
		});

		describe('getUniqueSessionIds', () => {
			it('returns unique session IDs from events', () => {
				const sessionIds = getUniqueSessionIds();

				expect(sessionIds).toContain('session-a');
				expect(sessionIds).toContain('session-b');
				expect(sessionIds.length).toBe(2);
			});

			it('returns sorted array', () => {
				const sessionIds = getUniqueSessionIds();

				expect(sessionIds).toEqual([...sessionIds].sort());
			});
		});
	});
});
