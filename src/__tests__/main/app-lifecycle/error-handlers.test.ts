/**
 * Tests for global error handlers setup.
 *
 * Tests cover:
 * - setupGlobalErrorHandlers registers process event listeners
 * - Uncaught exception handler logs errors
 * - Unhandled rejection handler logs errors
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
const mockLogger = {
	error: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
};

vi.mock('../../../main/utils/logger', () => ({
	logger: mockLogger,
}));

describe('app-lifecycle/error-handlers', () => {
	// Store handlers registered with process.on
	const registeredHandlers = new Map<string, (...args: unknown[]) => void>();
	let originalProcessOn: typeof process.on;

	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers.clear();

		// Save original and mock process.on
		originalProcessOn = process.on;
		process.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			registeredHandlers.set(event, handler);
			return process;
		}) as typeof process.on;

		// Reset module cache to ensure fresh import
		vi.resetModules();
	});

	afterEach(() => {
		// Restore original process.on
		process.on = originalProcessOn;
	});

	describe('setupGlobalErrorHandlers', () => {
		it('should register uncaughtException handler', async () => {
			const { setupGlobalErrorHandlers } =
				await import('../../../main/app-lifecycle/error-handlers');

			setupGlobalErrorHandlers();

			expect(registeredHandlers.has('uncaughtException')).toBe(true);
		});

		it('should register unhandledRejection handler', async () => {
			const { setupGlobalErrorHandlers } =
				await import('../../../main/app-lifecycle/error-handlers');

			setupGlobalErrorHandlers();

			expect(registeredHandlers.has('unhandledRejection')).toBe(true);
		});

		it('should log uncaught exceptions with error details', async () => {
			const { setupGlobalErrorHandlers } =
				await import('../../../main/app-lifecycle/error-handlers');

			setupGlobalErrorHandlers();

			const handler = registeredHandlers.get('uncaughtException');
			expect(handler).toBeDefined();

			const testError = new Error('Test uncaught error');
			testError.name = 'TestError';
			handler!(testError);

			expect(mockLogger.error).toHaveBeenCalledWith(
				'Uncaught Exception: Test uncaught error',
				'UncaughtException',
				expect.objectContaining({
					stack: expect.any(String),
					name: 'TestError',
				})
			);
		});

		it('should log unhandled rejections with Error reason', async () => {
			const { setupGlobalErrorHandlers } =
				await import('../../../main/app-lifecycle/error-handlers');

			setupGlobalErrorHandlers();

			const handler = registeredHandlers.get('unhandledRejection');
			expect(handler).toBeDefined();

			const testError = new Error('Test rejection error');
			const testPromise = Promise.resolve();
			handler!(testError, testPromise);

			expect(mockLogger.error).toHaveBeenCalledWith(
				'Unhandled Promise Rejection: Test rejection error',
				'UnhandledRejection',
				expect.objectContaining({
					reason: testError,
					stack: expect.any(String),
				})
			);
		});

		it('should log unhandled rejections with non-Error reason', async () => {
			const { setupGlobalErrorHandlers } =
				await import('../../../main/app-lifecycle/error-handlers');

			setupGlobalErrorHandlers();

			const handler = registeredHandlers.get('unhandledRejection');
			expect(handler).toBeDefined();

			const testReason = 'String rejection reason';
			const testPromise = Promise.resolve();
			handler!(testReason, testPromise);

			expect(mockLogger.error).toHaveBeenCalledWith(
				'Unhandled Promise Rejection: String rejection reason',
				'UnhandledRejection',
				expect.objectContaining({
					reason: testReason,
					stack: undefined,
				})
			);
		});
	});
});
