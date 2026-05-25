import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	clearAllRendererPerfMetrics,
	getAllRendererPerfMetrics,
	getRendererPerfMetrics,
	isRendererPerfEnabled,
	logger,
	type LogLevel,
	setRendererPerfEnabled,
} from '../../../renderer/utils/logger';

describe('logger', () => {
	let logSpy: ReturnType<typeof vi.fn>;
	let originalMaestro: typeof window.maestro;

	beforeEach(() => {
		// Save original maestro
		originalMaestro = window.maestro;

		// Create mock log function
		logSpy = vi.fn();

		// Set up window.maestro mock with logger
		(window as any).maestro = {
			logger: {
				log: logSpy,
			},
		};

		setRendererPerfEnabled(false);
		clearAllRendererPerfMetrics();
		logSpy.mockClear();
	});

	afterEach(() => {
		// Restore original maestro
		(window as any).maestro = originalMaestro;
		vi.restoreAllMocks();
	});

	describe('LogLevel type', () => {
		it('should accept valid log levels', () => {
			const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
			expect(levels).toHaveLength(4);
		});
	});

	describe('logger singleton', () => {
		it('should be defined', () => {
			expect(logger).toBeDefined();
		});

		it('should have debug method', () => {
			expect(logger.debug).toBeInstanceOf(Function);
		});

		it('should have info method', () => {
			expect(logger.info).toBeInstanceOf(Function);
		});

		it('should have warn method', () => {
			expect(logger.warn).toBeInstanceOf(Function);
		});

		it('should have error method', () => {
			expect(logger.error).toBeInstanceOf(Function);
		});
	});

	describe('debug', () => {
		it('should call window.maestro.logger.log with debug level', () => {
			logger.debug('test message');
			expect(logSpy).toHaveBeenCalledWith('debug', 'test message', undefined, undefined);
		});

		it('should pass context parameter', () => {
			logger.debug('test message', 'TestContext');
			expect(logSpy).toHaveBeenCalledWith('debug', 'test message', 'TestContext', undefined);
		});

		it('should pass data parameter', () => {
			const data = { key: 'value' };
			logger.debug('test message', 'TestContext', data);
			expect(logSpy).toHaveBeenCalledWith('debug', 'test message', 'TestContext', data);
		});

		it('should handle empty message', () => {
			logger.debug('');
			expect(logSpy).toHaveBeenCalledWith('debug', '', undefined, undefined);
		});

		it('should handle complex data objects', () => {
			const data = {
				nested: { deep: { value: 123 } },
				array: [1, 2, 3],
				bool: true,
			};
			logger.debug('complex', 'Context', data);
			expect(logSpy).toHaveBeenCalledWith('debug', 'complex', 'Context', data);
		});
	});

	describe('info', () => {
		it('should call window.maestro.logger.log with info level', () => {
			logger.info('info message');
			expect(logSpy).toHaveBeenCalledWith('info', 'info message', undefined, undefined);
		});

		it('should pass context parameter', () => {
			logger.info('info message', 'InfoContext');
			expect(logSpy).toHaveBeenCalledWith('info', 'info message', 'InfoContext', undefined);
		});

		it('should pass data parameter', () => {
			const data = ['array', 'data'];
			logger.info('info message', 'InfoContext', data);
			expect(logSpy).toHaveBeenCalledWith('info', 'info message', 'InfoContext', data);
		});
	});

	describe('warn', () => {
		it('should call window.maestro.logger.log with warn level', () => {
			logger.warn('warning message');
			expect(logSpy).toHaveBeenCalledWith('warn', 'warning message', undefined, undefined);
		});

		it('should pass context parameter', () => {
			logger.warn('warning message', 'WarnContext');
			expect(logSpy).toHaveBeenCalledWith('warn', 'warning message', 'WarnContext', undefined);
		});

		it('should pass data parameter', () => {
			const data = new Date();
			logger.warn('warning message', 'WarnContext', data);
			expect(logSpy).toHaveBeenCalledWith('warn', 'warning message', 'WarnContext', data);
		});
	});

	describe('error', () => {
		it('should call window.maestro.logger.log with error level', () => {
			logger.error('error message');
			expect(logSpy).toHaveBeenCalledWith('error', 'error message', undefined, undefined);
		});

		it('should pass context parameter', () => {
			logger.error('error message', 'ErrorContext');
			expect(logSpy).toHaveBeenCalledWith('error', 'error message', 'ErrorContext', undefined);
		});

		it('should pass data parameter', () => {
			const error = new Error('test error');
			logger.error('error message', 'ErrorContext', error);
			expect(logSpy).toHaveBeenCalledWith('error', 'error message', 'ErrorContext', error);
		});

		it('should handle error objects as data', () => {
			const error = { code: 'ERR_001', details: 'Something went wrong' };
			logger.error('error occurred', 'ErrorHandler', error);
			expect(logSpy).toHaveBeenCalledWith('error', 'error occurred', 'ErrorHandler', error);
		});
	});

	describe('window.maestro unavailable', () => {
		it('should handle undefined window.maestro gracefully', () => {
			(window as any).maestro = undefined;

			// Should not throw
			expect(() => logger.debug('test')).not.toThrow();
			expect(() => logger.info('test')).not.toThrow();
			expect(() => logger.warn('test')).not.toThrow();
			expect(() => logger.error('test')).not.toThrow();
		});

		it('should handle null window.maestro gracefully', () => {
			(window as any).maestro = null;

			expect(() => logger.debug('test')).not.toThrow();
			expect(() => logger.info('test')).not.toThrow();
			expect(() => logger.warn('test')).not.toThrow();
			expect(() => logger.error('test')).not.toThrow();
		});

		it('should handle undefined logger gracefully', () => {
			(window as any).maestro = { logger: undefined };

			expect(() => logger.debug('test')).not.toThrow();
			expect(() => logger.info('test')).not.toThrow();
			expect(() => logger.warn('test')).not.toThrow();
			expect(() => logger.error('test')).not.toThrow();
		});

		it('should handle null logger gracefully', () => {
			(window as any).maestro = { logger: null };

			expect(() => logger.debug('test')).not.toThrow();
			expect(() => logger.info('test')).not.toThrow();
			expect(() => logger.warn('test')).not.toThrow();
			expect(() => logger.error('test')).not.toThrow();
		});
	});

	describe('edge cases', () => {
		it('should handle undefined data', () => {
			logger.debug('message', 'context', undefined);
			expect(logSpy).toHaveBeenCalledWith('debug', 'message', 'context', undefined);
		});

		it('should handle null data', () => {
			logger.debug('message', 'context', null);
			expect(logSpy).toHaveBeenCalledWith('debug', 'message', 'context', null);
		});

		it('should handle numeric data', () => {
			logger.debug('message', 'context', 42);
			expect(logSpy).toHaveBeenCalledWith('debug', 'message', 'context', 42);
		});

		it('should handle string data', () => {
			logger.debug('message', 'context', 'string data');
			expect(logSpy).toHaveBeenCalledWith('debug', 'message', 'context', 'string data');
		});

		it('should handle boolean data', () => {
			logger.debug('message', 'context', true);
			expect(logSpy).toHaveBeenCalledWith('debug', 'message', 'context', true);
		});

		it('should handle empty context', () => {
			logger.debug('message', '');
			expect(logSpy).toHaveBeenCalledWith('debug', 'message', '', undefined);
		});

		it('should handle special characters in message', () => {
			const message = 'Message with special chars: éàü ™ © ® 日本語 🎉';
			logger.debug(message);
			expect(logSpy).toHaveBeenCalledWith('debug', message, undefined, undefined);
		});

		it('should handle very long messages', () => {
			const longMessage = 'a'.repeat(10000);
			logger.debug(longMessage);
			expect(logSpy).toHaveBeenCalledWith('debug', longMessage, undefined, undefined);
		});

		it('should handle circular reference in data gracefully', () => {
			const circular: any = { a: 1 };
			circular.self = circular;

			// The logger just passes the data to IPC, doesn't stringify
			expect(() => logger.debug('message', 'context', circular)).not.toThrow();
			expect(logSpy).toHaveBeenCalledWith('debug', 'message', 'context', circular);
		});

		it('should handle functions in data', () => {
			const func = () => 'test';
			logger.debug('message', 'context', func);
			expect(logSpy).toHaveBeenCalledWith('debug', 'message', 'context', func);
		});

		it('should handle Symbol in data', () => {
			const sym = Symbol('test');
			logger.debug('message', 'context', sym);
			expect(logSpy).toHaveBeenCalledWith('debug', 'message', 'context', sym);
		});
	});

	describe('multiple calls', () => {
		it('should handle multiple consecutive calls', () => {
			logger.debug('debug 1');
			logger.info('info 1');
			logger.warn('warn 1');
			logger.error('error 1');

			expect(logSpy).toHaveBeenCalledTimes(4);
			expect(logSpy).toHaveBeenNthCalledWith(1, 'debug', 'debug 1', undefined, undefined);
			expect(logSpy).toHaveBeenNthCalledWith(2, 'info', 'info 1', undefined, undefined);
			expect(logSpy).toHaveBeenNthCalledWith(3, 'warn', 'warn 1', undefined, undefined);
			expect(logSpy).toHaveBeenNthCalledWith(4, 'error', 'error 1', undefined, undefined);
		});

		it('should handle rapid successive calls', () => {
			for (let i = 0; i < 100; i++) {
				logger.debug(`message ${i}`);
			}
			expect(logSpy).toHaveBeenCalledTimes(100);
		});
	});

	describe('type safety', () => {
		it('should accept unknown type for data parameter', () => {
			// These should all compile and work
			logger.debug('msg', 'ctx', 123);
			logger.debug('msg', 'ctx', 'string');
			logger.debug('msg', 'ctx', { obj: true });
			logger.debug('msg', 'ctx', [1, 2, 3]);
			logger.debug('msg', 'ctx', null);
			logger.debug('msg', 'ctx', undefined);

			expect(logSpy).toHaveBeenCalledTimes(6);
		});
	});

	describe('renderer performance metrics', () => {
		it('caches performance metrics instances by context', () => {
			const first = getRendererPerfMetrics('DocumentGraph');
			const second = getRendererPerfMetrics('DocumentGraph');
			const other = getRendererPerfMetrics('UsageDashboard');

			expect(first).toBe(second);
			expect(other).not.toBe(first);
			expect(first.isEnabled()).toBe(false);
			expect(other.isEnabled()).toBe(false);
		});

		it('toggles renderer performance metrics for existing instances', () => {
			const metrics = getRendererPerfMetrics('DocumentGraph');

			setRendererPerfEnabled(true);

			expect(isRendererPerfEnabled()).toBe(true);
			expect(metrics.isEnabled()).toBe(true);
			expect(logSpy).toHaveBeenLastCalledWith(
				'info',
				'Renderer performance metrics enabled',
				'[RendererPerf]',
				undefined
			);

			setRendererPerfEnabled(false);

			expect(isRendererPerfEnabled()).toBe(false);
			expect(metrics.isEnabled()).toBe(false);
			expect(logSpy).toHaveBeenLastCalledWith(
				'info',
				'Renderer performance metrics disabled',
				'[RendererPerf]',
				undefined
			);
		});

		it('returns collected metrics sorted by timestamp and clears them', () => {
			const dateNow = vi.spyOn(Date, 'now');
			const alpha = getRendererPerfMetrics('Alpha');
			const beta = getRendererPerfMetrics('Beta');
			setRendererPerfEnabled(true);
			logSpy.mockClear();

			dateNow.mockReturnValueOnce(2000);
			alpha.end(0, 'second', { order: 2 });
			dateNow.mockReturnValueOnce(1000);
			beta.end(0, 'first', { order: 1 });

			const metrics = getAllRendererPerfMetrics();

			expect(metrics.map((metric) => metric.name)).toEqual(['first', 'second']);
			expect(metrics.map((metric) => metric.context)).toEqual(['Beta', 'Alpha']);
			expect(logSpy).toHaveBeenCalledWith(
				'debug',
				expect.stringMatching(/^\[PERF\] second: .*ms {"order":2}$/),
				'[Alpha]',
				undefined
			);
			expect(logSpy).toHaveBeenCalledWith(
				'debug',
				expect.stringMatching(/^\[PERF\] first: .*ms {"order":1}$/),
				'[Beta]',
				undefined
			);

			clearAllRendererPerfMetrics();

			expect(getAllRendererPerfMetrics()).toEqual([]);
		});

		it('does not collect metrics while disabled', () => {
			const metrics = getRendererPerfMetrics('DisabledContext');

			expect(isRendererPerfEnabled()).toBe(false);
			expect(metrics.end(0, 'ignored')).toBeGreaterThanOrEqual(0);

			expect(getAllRendererPerfMetrics()).toEqual([]);
			expect(logSpy).not.toHaveBeenCalledWith(
				'debug',
				expect.stringContaining('[PERF] ignored'),
				'[DisabledContext]',
				undefined
			);
		});
	});
});
