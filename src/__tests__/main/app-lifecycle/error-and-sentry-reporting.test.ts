// Source: src/__tests__/main/app-lifecycle/error-handlers.test.ts
// Source: src/__tests__/main/utils/sentry-scope-tags.test.ts
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { attachSentryScopeTags } from '../../../main/utils/sentry';
import { noteSentryAgentInventory } from '../../../main/utils/sentry';
import { noteSentryWorkReasons } from '../../../main/utils/sentry';
import { resetSentryScopeTagsForTests } from '../../../main/utils/sentry';
import { setSentryScopeTags } from '../../../main/utils/sentry';
const mockLogger = vi.hoisted(() => ({
	error: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: mockLogger,
}));
describe('error-handlers', () => {
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
});
describe('sentry-scope-tags', () => {
	describe('Sentry scope tags (main)', () => {
		beforeEach(() => {
			resetSentryScopeTagsForTests();
		});

		it('holds tags recorded before Sentry initializes and delivers them on attach', () => {
			setSentryScopeTags({ 'autorun.count': '1' });
			noteSentryAgentInventory([{ toolType: 'codex' }]);

			const setTags = vi.fn();
			attachSentryScopeTags({ setTags });

			expect(setTags).toHaveBeenCalledTimes(1);
			expect(setTags).toHaveBeenCalledWith({
				'autorun.count': '1',
				'agents.count': '1',
				'agents.providers': 'codex',
			});
		});

		it('only forwards tags whose value changed', () => {
			const setTags = vi.fn();
			attachSentryScopeTags({ setTags });

			noteSentryWorkReasons(['session:a']);
			expect(setTags).toHaveBeenCalledTimes(1);

			// Same summary from a different reason set: nothing changed.
			noteSentryWorkReasons(['session:b']);
			expect(setTags).toHaveBeenCalledTimes(1);

			noteSentryWorkReasons(['session:b', 'autorun:c']);
			expect(setTags).toHaveBeenCalledTimes(2);
			expect(setTags).toHaveBeenLastCalledWith({ 'autorun.count': '1' });
		});

		it('does not attach anything when Sentry never initializes', () => {
			// Crash reporting off: setters still work and nothing throws.
			expect(() => noteSentryWorkReasons(['autorun:x'])).not.toThrow();
		});

		it('swallows a failing scope write so the reporting state change survives', () => {
			attachSentryScopeTags({
				setTags: () => {
					throw new Error('scope gone');
				},
			});
			expect(() => setSentryScopeTags({ 'agents.count': '3' })).not.toThrow();
		});
	});
});
