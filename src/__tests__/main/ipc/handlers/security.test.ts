/**
 * Tests for the Security IPC handlers
 *
 * These tests verify that the security event handlers correctly
 * delegate to the security logger and return appropriate results.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import { registerSecurityHandlers } from '../../../../main/ipc/handlers/security';
import * as securityLogger from '../../../../main/security/security-logger';

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

// Mock the security logger module
vi.mock('../../../../main/security/security-logger', () => ({
	getRecentEvents: vi.fn(),
	getEventsByType: vi.fn(),
	getEventsBySession: vi.fn(),
	clearEvents: vi.fn(),
	clearAllEvents: vi.fn(),
	getEventStats: vi.fn(),
}));

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

describe('security IPC handlers', () => {
	let handlers: Map<string, Function>;

	beforeEach(() => {
		vi.clearAllMocks();

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Register handlers
		registerSecurityHandlers();
	});

	afterEach(() => {
		handlers.clear();
	});

	describe('registration', () => {
		it('should register all security handlers', () => {
			const expectedChannels = [
				'security:events:get',
				'security:events:getByType',
				'security:events:getBySession',
				'security:events:clear',
				'security:events:clearAll',
				'security:events:stats',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel)).toBe(true);
			}
		});
	});

	describe('security:events:get', () => {
		it('should return paginated events with default parameters', async () => {
			const mockPage = {
				events: [
					{
						id: 'event-1',
						timestamp: Date.now(),
						sessionId: 'session-1',
						eventType: 'input_scan',
						findings: [],
						action: 'none',
						originalLength: 100,
						sanitizedLength: 100,
					},
				],
				total: 1,
				hasMore: false,
			};

			vi.mocked(securityLogger.getRecentEvents).mockReturnValue(mockPage);

			const handler = handlers.get('security:events:get');
			const result = await handler!({} as any);

			expect(securityLogger.getRecentEvents).toHaveBeenCalledWith(50, 0);
			expect(result).toEqual(mockPage);
		});

		it('should pass custom limit and offset', async () => {
			const mockPage = {
				events: [],
				total: 100,
				hasMore: true,
			};

			vi.mocked(securityLogger.getRecentEvents).mockReturnValue(mockPage);

			const handler = handlers.get('security:events:get');
			const result = await handler!({} as any, 25, 50);

			expect(securityLogger.getRecentEvents).toHaveBeenCalledWith(25, 50);
			expect(result).toEqual(mockPage);
		});
	});

	describe('security:events:getByType', () => {
		it('should return events filtered by type', async () => {
			const mockEvents = [
				{
					id: 'event-1',
					timestamp: Date.now(),
					sessionId: 'session-1',
					eventType: 'blocked',
					findings: [],
					action: 'blocked',
					originalLength: 100,
					sanitizedLength: 0,
				},
			];

			vi.mocked(securityLogger.getEventsByType).mockReturnValue(mockEvents);

			const handler = handlers.get('security:events:getByType');
			const result = await handler!({} as any, 'blocked', 25);

			expect(securityLogger.getEventsByType).toHaveBeenCalledWith('blocked', 25);
			expect(result).toEqual(mockEvents);
		});

		it('should use default limit when not provided', async () => {
			vi.mocked(securityLogger.getEventsByType).mockReturnValue([]);

			const handler = handlers.get('security:events:getByType');
			await handler!({} as any, 'input_scan');

			expect(securityLogger.getEventsByType).toHaveBeenCalledWith('input_scan', 50);
		});
	});

	describe('security:events:getBySession', () => {
		it('should return events for a specific session', async () => {
			const mockEvents = [
				{
					id: 'event-1',
					timestamp: Date.now(),
					sessionId: 'session-abc',
					eventType: 'input_scan',
					findings: [],
					action: 'sanitized',
					originalLength: 100,
					sanitizedLength: 90,
				},
			];

			vi.mocked(securityLogger.getEventsBySession).mockReturnValue(mockEvents);

			const handler = handlers.get('security:events:getBySession');
			const result = await handler!({} as any, 'session-abc', 10);

			expect(securityLogger.getEventsBySession).toHaveBeenCalledWith('session-abc', 10);
			expect(result).toEqual(mockEvents);
		});

		it('should use default limit when not provided', async () => {
			vi.mocked(securityLogger.getEventsBySession).mockReturnValue([]);

			const handler = handlers.get('security:events:getBySession');
			await handler!({} as any, 'session-xyz');

			expect(securityLogger.getEventsBySession).toHaveBeenCalledWith('session-xyz', 50);
		});
	});

	describe('security:events:clear', () => {
		it('should clear events from memory', async () => {
			const handler = handlers.get('security:events:clear');
			await handler!({} as any);

			expect(securityLogger.clearEvents).toHaveBeenCalledTimes(1);
		});
	});

	describe('security:events:clearAll', () => {
		it('should clear all events including persisted file', async () => {
			const handler = handlers.get('security:events:clearAll');
			await handler!({} as any);

			expect(securityLogger.clearAllEvents).toHaveBeenCalledTimes(1);
		});
	});

	describe('security:events:stats', () => {
		it('should return event buffer statistics', async () => {
			const mockStats = {
				bufferSize: 42,
				totalLogged: 150,
				maxSize: 1000,
			};

			vi.mocked(securityLogger.getEventStats).mockReturnValue(mockStats);

			const handler = handlers.get('security:events:stats');
			const result = await handler!({} as any);

			expect(securityLogger.getEventStats).toHaveBeenCalledTimes(1);
			expect(result).toEqual(mockStats);
		});
	});
});
