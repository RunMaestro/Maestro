/**
 * Tests for security preload API
 *
 * Coverage:
 * - createSecurityApi: onSecurityEvent, getEvents, getEventsByType,
 *   getEventsBySession, clearEvents, clearAllEvents, getStats
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

import {
	createSecurityApi,
	type SecurityEventData,
	type SecurityEventsPage,
} from '../../../main/preload/security';

describe('Security Preload API', () => {
	let api: ReturnType<typeof createSecurityApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createSecurityApi();
	});

	describe('onSecurityEvent', () => {
		it('should subscribe to security:event channel', () => {
			const callback = vi.fn();

			api.onSecurityEvent(callback);

			expect(mockOn).toHaveBeenCalledWith('security:event', expect.any(Function));
		});

		it('should call callback when event is received', () => {
			const callback = vi.fn();
			let capturedHandler: Function;

			mockOn.mockImplementation((_channel, handler) => {
				capturedHandler = handler;
			});

			api.onSecurityEvent(callback);

			// Simulate event being received
			const mockEvent: SecurityEventData = {
				sessionId: 'session-1',
				eventType: 'input_scan',
				findingTypes: ['PII_EMAIL'],
				findingCount: 1,
				action: 'sanitized',
				originalLength: 100,
				sanitizedLength: 90,
			};

			capturedHandler!({}, mockEvent);

			expect(callback).toHaveBeenCalledWith(mockEvent);
		});

		it('should return unsubscribe function that removes listener', () => {
			const callback = vi.fn();
			let capturedHandler: Function;

			mockOn.mockImplementation((_channel, handler) => {
				capturedHandler = handler;
			});

			const unsubscribe = api.onSecurityEvent(callback);

			unsubscribe();

			expect(mockRemoveListener).toHaveBeenCalledWith('security:event', capturedHandler!);
		});
	});

	describe('getEvents', () => {
		it('should invoke security:events:get with default parameters', async () => {
			const mockPage: SecurityEventsPage = {
				events: [],
				total: 0,
				hasMore: false,
			};
			mockInvoke.mockResolvedValue(mockPage);

			const result = await api.getEvents();

			expect(mockInvoke).toHaveBeenCalledWith('security:events:get', undefined, undefined);
			expect(result).toEqual(mockPage);
		});

		it('should invoke security:events:get with custom limit and offset', async () => {
			const mockPage: SecurityEventsPage = {
				events: [
					{
						id: 'event-1',
						timestamp: Date.now(),
						sessionId: 'session-1',
						eventType: 'input_scan',
						findings: [],
						action: 'none',
						originalLength: 50,
						sanitizedLength: 50,
					},
				],
				total: 100,
				hasMore: true,
			};
			mockInvoke.mockResolvedValue(mockPage);

			const result = await api.getEvents(25, 50);

			expect(mockInvoke).toHaveBeenCalledWith('security:events:get', 25, 50);
			expect(result).toEqual(mockPage);
		});
	});

	describe('getEventsByType', () => {
		it('should invoke security:events:getByType with event type', async () => {
			const mockEvents = [
				{
					id: 'event-1',
					timestamp: Date.now(),
					sessionId: 'session-1',
					eventType: 'blocked' as const,
					findings: [],
					action: 'blocked' as const,
					originalLength: 100,
					sanitizedLength: 0,
				},
			];
			mockInvoke.mockResolvedValue(mockEvents);

			const result = await api.getEventsByType('blocked');

			expect(mockInvoke).toHaveBeenCalledWith('security:events:getByType', 'blocked', undefined);
			expect(result).toEqual(mockEvents);
		});

		it('should invoke security:events:getByType with custom limit', async () => {
			mockInvoke.mockResolvedValue([]);

			await api.getEventsByType('warning', 10);

			expect(mockInvoke).toHaveBeenCalledWith('security:events:getByType', 'warning', 10);
		});
	});

	describe('getEventsBySession', () => {
		it('should invoke security:events:getBySession with session ID', async () => {
			const mockEvents = [
				{
					id: 'event-1',
					timestamp: Date.now(),
					sessionId: 'session-abc',
					eventType: 'input_scan' as const,
					findings: [],
					action: 'sanitized' as const,
					originalLength: 100,
					sanitizedLength: 90,
				},
			];
			mockInvoke.mockResolvedValue(mockEvents);

			const result = await api.getEventsBySession('session-abc');

			expect(mockInvoke).toHaveBeenCalledWith(
				'security:events:getBySession',
				'session-abc',
				undefined
			);
			expect(result).toEqual(mockEvents);
		});

		it('should invoke security:events:getBySession with custom limit', async () => {
			mockInvoke.mockResolvedValue([]);

			await api.getEventsBySession('session-xyz', 5);

			expect(mockInvoke).toHaveBeenCalledWith('security:events:getBySession', 'session-xyz', 5);
		});
	});

	describe('clearEvents', () => {
		it('should invoke security:events:clear', async () => {
			mockInvoke.mockResolvedValue(undefined);

			await api.clearEvents();

			expect(mockInvoke).toHaveBeenCalledWith('security:events:clear');
		});
	});

	describe('clearAllEvents', () => {
		it('should invoke security:events:clearAll', async () => {
			mockInvoke.mockResolvedValue(undefined);

			await api.clearAllEvents();

			expect(mockInvoke).toHaveBeenCalledWith('security:events:clearAll');
		});
	});

	describe('getStats', () => {
		it('should invoke security:events:stats and return statistics', async () => {
			const mockStats = {
				bufferSize: 42,
				totalLogged: 150,
				maxSize: 1000,
			};
			mockInvoke.mockResolvedValue(mockStats);

			const result = await api.getStats();

			expect(mockInvoke).toHaveBeenCalledWith('security:events:stats');
			expect(result).toEqual(mockStats);
		});
	});
});
