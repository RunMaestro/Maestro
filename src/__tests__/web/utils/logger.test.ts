/**
 * Tests for src/web/utils/logger.ts
 *
 * Covers the webLogger utility for structured logging in the web interface.
 * Tests all log methods, level filtering, configuration, and message formatting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to import fresh copies for each test to reset module state
let webLogger: typeof import('../../../web/utils/logger').webLogger;
let defaultExport: typeof import('../../../web/utils/logger').default;

describe('src/web/utils/logger.ts', () => {
	// Spy on console methods
	let consoleSpy: {
		debug: ReturnType<typeof vi.spyOn>;
		info: ReturnType<typeof vi.spyOn>;
		warn: ReturnType<typeof vi.spyOn>;
		error: ReturnType<typeof vi.spyOn>;
	};

	beforeEach(async () => {
		// Reset mocks
		vi.resetModules();

		// Spy on console methods
		consoleSpy = {
			debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
			info: vi.spyOn(console, 'info').mockImplementation(() => {}),
			warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
			error: vi.spyOn(console, 'error').mockImplementation(() => {}),
		};

		// Import fresh module
		const module = await import('../../../web/utils/logger');
		webLogger = module.webLogger;
		defaultExport = module.default;

		// Reset to default state after import
		webLogger.reset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('exports', () => {
		it('exports webLogger object', () => {
			expect(webLogger).toBeDefined();
			expect(typeof webLogger).toBe('object');
		});

		it('exports webLogger as default', () => {
			expect(defaultExport).toBe(webLogger);
		});

		it('webLogger has all expected methods', () => {
			expect(typeof webLogger.debug).toBe('function');
			expect(typeof webLogger.info).toBe('function');
			expect(typeof webLogger.warn).toBe('function');
			expect(typeof webLogger.error).toBe('function');
			expect(typeof webLogger.setLevel).toBe('function');
			expect(typeof webLogger.getLevel).toBe('function');
			expect(typeof webLogger.setEnabled).toBe('function');
			expect(typeof webLogger.isEnabled).toBe('function');
			expect(typeof webLogger.enableDebug).toBe('function');
			expect(typeof webLogger.reset).toBe('function');
		});
	});

	describe('default configuration', () => {
		it('has default minLevel of warn', () => {
			expect(webLogger.getLevel()).toBe('warn');
		});

		it('is enabled by default', () => {
			expect(webLogger.isEnabled()).toBe(true);
		});

		it('does not log debug by default', () => {
			webLogger.debug('test message');
			expect(consoleSpy.debug).not.toHaveBeenCalled();
		});

		it('does not log info by default', () => {
			webLogger.info('test message');
			expect(consoleSpy.info).not.toHaveBeenCalled();
		});

		it('logs warn by default', () => {
			webLogger.warn('test message');
			expect(consoleSpy.warn).toHaveBeenCalled();
		});

		it('logs error by default', () => {
			webLogger.error('test message');
			expect(consoleSpy.error).toHaveBeenCalled();
		});
	});

	describe('debug()', () => {
		beforeEach(() => {
			webLogger.setLevel('debug');
		});

		it('logs message when level is debug', () => {
			webLogger.debug('debug message');
			expect(consoleSpy.debug).toHaveBeenCalledWith('[WebUI] debug message');
		});

		it('logs message with context', () => {
			webLogger.debug('debug message', 'TestContext');
			expect(consoleSpy.debug).toHaveBeenCalledWith('[WebUI] [TestContext] debug message');
		});

		it('logs message with data', () => {
			const data = { key: 'value' };
			webLogger.debug('debug message', undefined, data);
			expect(consoleSpy.debug).toHaveBeenCalledWith('[WebUI] debug message', data);
		});

		it('logs message with context and data', () => {
			const data = { key: 'value' };
			webLogger.debug('debug message', 'Context', data);
			expect(consoleSpy.debug).toHaveBeenCalledWith('[WebUI] [Context] debug message', data);
		});

		it('does not log when disabled', () => {
			webLogger.setEnabled(false);
			webLogger.debug('debug message');
			expect(consoleSpy.debug).not.toHaveBeenCalled();
		});

		it('does not log when level is higher than debug', () => {
			webLogger.setLevel('info');
			webLogger.debug('debug message');
			expect(consoleSpy.debug).not.toHaveBeenCalled();
		});
	});

	describe('info()', () => {
		beforeEach(() => {
			webLogger.setLevel('info');
		});

		it('logs message when level is info or lower', () => {
			webLogger.info('info message');
			expect(consoleSpy.info).toHaveBeenCalledWith('[WebUI] info message');
		});

		it('logs message with context', () => {
			webLogger.info('info message', 'TestContext');
			expect(consoleSpy.info).toHaveBeenCalledWith('[WebUI] [TestContext] info message');
		});

		it('logs message with data', () => {
			const data = { key: 'value' };
			webLogger.info('info message', undefined, data);
			expect(consoleSpy.info).toHaveBeenCalledWith('[WebUI] info message', data);
		});

		it('logs message with context and data', () => {
			const data = { count: 42 };
			webLogger.info('info message', 'Module', data);
			expect(consoleSpy.info).toHaveBeenCalledWith('[WebUI] [Module] info message', data);
		});

		it('does not log when disabled', () => {
			webLogger.setEnabled(false);
			webLogger.info('info message');
			expect(consoleSpy.info).not.toHaveBeenCalled();
		});

		it('does not log when level is higher than info', () => {
			webLogger.setLevel('warn');
			webLogger.info('info message');
			expect(consoleSpy.info).not.toHaveBeenCalled();
		});

		it('logs when level is debug (lower than info)', () => {
			webLogger.setLevel('debug');
			webLogger.info('info message');
			expect(consoleSpy.info).toHaveBeenCalled();
		});
	});

	describe('warn()', () => {
		beforeEach(() => {
			webLogger.setLevel('warn');
		});

		it('logs message when level is warn or lower', () => {
			webLogger.warn('warn message');
			expect(consoleSpy.warn).toHaveBeenCalledWith('[WebUI] warn message');
		});

		it('logs message with context', () => {
			webLogger.warn('warn message', 'TestContext');
			expect(consoleSpy.warn).toHaveBeenCalledWith('[WebUI] [TestContext] warn message');
		});

		it('logs message with data', () => {
			const data = { warning: 'details' };
			webLogger.warn('warn message', undefined, data);
			expect(consoleSpy.warn).toHaveBeenCalledWith('[WebUI] warn message', data);
		});

		it('logs message with context and data', () => {
			const data = { issue: 'something' };
			webLogger.warn('warn message', 'Warning', data);
			expect(consoleSpy.warn).toHaveBeenCalledWith('[WebUI] [Warning] warn message', data);
		});

		it('does not log when disabled', () => {
			webLogger.setEnabled(false);
			webLogger.warn('warn message');
			expect(consoleSpy.warn).not.toHaveBeenCalled();
		});

		it('does not log when level is higher than warn', () => {
			webLogger.setLevel('error');
			webLogger.warn('warn message');
			expect(consoleSpy.warn).not.toHaveBeenCalled();
		});

		it('logs when level is info (lower than warn)', () => {
			webLogger.setLevel('info');
			webLogger.warn('warn message');
			expect(consoleSpy.warn).toHaveBeenCalled();
		});
	});

	describe('error()', () => {
		beforeEach(() => {
			webLogger.setLevel('error');
		});

		it('logs message at any level', () => {
			webLogger.error('error message');
			expect(consoleSpy.error).toHaveBeenCalledWith('[WebUI] error message');
		});

		it('logs message with context', () => {
			webLogger.error('error message', 'TestContext');
			expect(consoleSpy.error).toHaveBeenCalledWith('[WebUI] [TestContext] error message');
		});

		it('logs message with data', () => {
			const error = new Error('test error');
			webLogger.error('error message', undefined, error);
			expect(consoleSpy.error).toHaveBeenCalledWith('[WebUI] error message', error);
		});

		it('logs message with context and data', () => {
			const data = { code: 500, message: 'Internal error' };
			webLogger.error('error message', 'API', data);
			expect(consoleSpy.error).toHaveBeenCalledWith('[WebUI] [API] error message', data);
		});

		it('does not log when disabled', () => {
			webLogger.setEnabled(false);
			webLogger.error('error message');
			expect(consoleSpy.error).not.toHaveBeenCalled();
		});

		it('logs when level is warn (lower than error)', () => {
			webLogger.setLevel('warn');
			webLogger.error('error message');
			expect(consoleSpy.error).toHaveBeenCalled();
		});

		it('logs when level is debug (lowest)', () => {
			webLogger.setLevel('debug');
			webLogger.error('error message');
			expect(consoleSpy.error).toHaveBeenCalled();
		});
	});

	describe('setLevel()', () => {
		it('sets level to debug', () => {
			webLogger.setLevel('debug');
			expect(webLogger.getLevel()).toBe('debug');
		});

		it('sets level to info', () => {
			webLogger.setLevel('info');
			expect(webLogger.getLevel()).toBe('info');
		});

		it('sets level to warn', () => {
			webLogger.setLevel('warn');
			expect(webLogger.getLevel()).toBe('warn');
		});

		it('sets level to error', () => {
			webLogger.setLevel('error');
			expect(webLogger.getLevel()).toBe('error');
		});

		it('affects logging behavior immediately', () => {
			webLogger.setLevel('error');
			webLogger.warn('should not appear');
			expect(consoleSpy.warn).not.toHaveBeenCalled();

			webLogger.setLevel('warn');
			webLogger.warn('should appear');
			expect(consoleSpy.warn).toHaveBeenCalled();
		});
	});

	describe('getLevel()', () => {
		it('returns current log level', () => {
			expect(webLogger.getLevel()).toBe('warn'); // default

			webLogger.setLevel('debug');
			expect(webLogger.getLevel()).toBe('debug');

			webLogger.setLevel('error');
			expect(webLogger.getLevel()).toBe('error');
		});
	});

	describe('setEnabled()', () => {
		it('disables all logging when set to false', () => {
			webLogger.setLevel('debug');
			webLogger.setEnabled(false);

			webLogger.debug('test');
			webLogger.info('test');
			webLogger.warn('test');
			webLogger.error('test');

			expect(consoleSpy.debug).not.toHaveBeenCalled();
			expect(consoleSpy.info).not.toHaveBeenCalled();
			expect(consoleSpy.warn).not.toHaveBeenCalled();
			expect(consoleSpy.error).not.toHaveBeenCalled();
		});

		it('enables logging when set to true', () => {
			webLogger.setEnabled(false);
			webLogger.setEnabled(true);

			webLogger.warn('test');
			expect(consoleSpy.warn).toHaveBeenCalled();
		});
	});

	describe('isEnabled()', () => {
		it('returns true when logging is enabled', () => {
			expect(webLogger.isEnabled()).toBe(true);
		});

		it('returns false when logging is disabled', () => {
			webLogger.setEnabled(false);
			expect(webLogger.isEnabled()).toBe(false);
		});

		it('reflects changes from setEnabled', () => {
			expect(webLogger.isEnabled()).toBe(true);
			webLogger.setEnabled(false);
			expect(webLogger.isEnabled()).toBe(false);
			webLogger.setEnabled(true);
			expect(webLogger.isEnabled()).toBe(true);
		});
	});

	describe('enableDebug()', () => {
		it('sets level to debug', () => {
			webLogger.setLevel('error');
			expect(webLogger.getLevel()).toBe('error');

			webLogger.enableDebug();
			expect(webLogger.getLevel()).toBe('debug');
		});

		it('enables all log levels', () => {
			webLogger.enableDebug();

			webLogger.debug('debug');
			webLogger.info('info');
			webLogger.warn('warn');
			webLogger.error('error');

			expect(consoleSpy.debug).toHaveBeenCalled();
			expect(consoleSpy.info).toHaveBeenCalled();
			expect(consoleSpy.warn).toHaveBeenCalled();
			expect(consoleSpy.error).toHaveBeenCalled();
		});
	});

	describe('reset()', () => {
		it('resets level to default (warn)', () => {
			webLogger.setLevel('debug');
			webLogger.reset();
			expect(webLogger.getLevel()).toBe('warn');
		});

		it('resets enabled to default (true)', () => {
			webLogger.setEnabled(false);
			webLogger.reset();
			expect(webLogger.isEnabled()).toBe(true);
		});

		it('resets all configuration to defaults', () => {
			webLogger.setLevel('error');
			webLogger.setEnabled(false);

			webLogger.reset();

			expect(webLogger.getLevel()).toBe('warn');
			expect(webLogger.isEnabled()).toBe(true);
		});

		it('restores default logging behavior', () => {
			webLogger.setLevel('error');
			webLogger.reset();

			// After reset, warn should log (default level is warn)
			webLogger.warn('test');
			expect(consoleSpy.warn).toHaveBeenCalled();

			// But info should not (below warn level)
			webLogger.info('test');
			expect(consoleSpy.info).not.toHaveBeenCalled();
		});
	});

	describe('message formatting', () => {
		beforeEach(() => {
			webLogger.setLevel('debug');
		});

		it('formats message with [WebUI] prefix', () => {
			webLogger.debug('test');
			expect(consoleSpy.debug).toHaveBeenCalledWith('[WebUI] test');
		});

		it('formats message with context in brackets', () => {
			webLogger.debug('test', 'MyContext');
			expect(consoleSpy.debug).toHaveBeenCalledWith('[WebUI] [MyContext] test');
		});

		it('handles empty string context', () => {
			webLogger.debug('test', '');
			// Empty string context results in no context brackets (empty string is truthy check but returns empty result)
			// Actually, empty string is falsy in JS, so no context is added
			expect(consoleSpy.debug).toHaveBeenCalledWith('[WebUI] test');
		});

		it('handles special characters in message', () => {
			webLogger.debug('test <script>alert("xss")</script>');
			expect(consoleSpy.debug).toHaveBeenCalledWith('[WebUI] test <script>alert("xss")</script>');
		});

		it('handles special characters in context', () => {
			webLogger.debug('test', '<Context>');
			expect(consoleSpy.debug).toHaveBeenCalledWith('[WebUI] [<Context>] test');
		});

		it('handles unicode in message', () => {
			webLogger.debug('日本語テスト 🎵');
			expect(consoleSpy.debug).toHaveBeenCalledWith('[WebUI] 日本語テスト 🎵');
		});

		it('handles unicode in context', () => {
			webLogger.debug('test', '🔧 Module');
			expect(consoleSpy.debug).toHaveBeenCalledWith('[WebUI] [🔧 Module] test');
		});

		it('handles newlines in message', () => {
			webLogger.debug('line1\nline2\nline3');
			expect(consoleSpy.debug).toHaveBeenCalledWith('[WebUI] line1\nline2\nline3');
		});
	});

	describe('data parameter handling', () => {
		beforeEach(() => {
			webLogger.setLevel('debug');
		});

		it('logs without data when undefined', () => {
			webLogger.debug('test', 'Ctx', undefined);
			expect(consoleSpy.debug).toHaveBeenCalledWith('[WebUI] [Ctx] test');
		});

		it('logs with data when provided', () => {
			webLogger.debug('test', 'Ctx', { key: 'value' });
			expect(consoleSpy.debug).toHaveBeenCalledWith('[WebUI] [Ctx] test', { key: 'value' });
		});

		it('handles null data', () => {
			webLogger.debug('test', undefined, null);
			expect(consoleSpy.debug).toHaveBeenCalledWith('[WebUI] test', null);
		});

		it('handles array data', () => {
			const arr = [1, 2, 3];
			webLogger.debug('test', undefined, arr);
			expect(consoleSpy.debug).toHaveBeenCalledWith('[WebUI] test', arr);
		});

		it('handles string data', () => {
			webLogger.debug('test', undefined, 'string data');
			expect(consoleSpy.debug).toHaveBeenCalledWith('[WebUI] test', 'string data');
		});

		it('handles number data', () => {
			webLogger.debug('test', undefined, 42);
			expect(consoleSpy.debug).toHaveBeenCalledWith('[WebUI] test', 42);
		});

		it('handles boolean data', () => {
			webLogger.debug('test', undefined, true);
			expect(consoleSpy.debug).toHaveBeenCalledWith('[WebUI] test', true);
		});

		it('handles Error objects', () => {
			const error = new Error('test error');
			webLogger.error('failed', 'Test', error);
			expect(consoleSpy.error).toHaveBeenCalledWith('[WebUI] [Test] failed', error);
		});

		it('handles nested objects', () => {
			const nested = {
				level1: {
					level2: {
						level3: 'deep',
					},
				},
			};
			webLogger.debug('test', undefined, nested);
			expect(consoleSpy.debug).toHaveBeenCalledWith('[WebUI] test', nested);
		});
	});

	describe('level priority', () => {
		it('debug is lowest priority (0)', () => {
			webLogger.setLevel('debug');

			webLogger.debug('test');
			webLogger.info('test');
			webLogger.warn('test');
			webLogger.error('test');

			expect(consoleSpy.debug).toHaveBeenCalled();
			expect(consoleSpy.info).toHaveBeenCalled();
			expect(consoleSpy.warn).toHaveBeenCalled();
			expect(consoleSpy.error).toHaveBeenCalled();
		});

		it('info filters debug', () => {
			webLogger.setLevel('info');

			webLogger.debug('test');
			webLogger.info('test');
			webLogger.warn('test');
			webLogger.error('test');

			expect(consoleSpy.debug).not.toHaveBeenCalled();
			expect(consoleSpy.info).toHaveBeenCalled();
			expect(consoleSpy.warn).toHaveBeenCalled();
			expect(consoleSpy.error).toHaveBeenCalled();
		});

		it('warn filters debug and info', () => {
			webLogger.setLevel('warn');

			webLogger.debug('test');
			webLogger.info('test');
			webLogger.warn('test');
			webLogger.error('test');

			expect(consoleSpy.debug).not.toHaveBeenCalled();
			expect(consoleSpy.info).not.toHaveBeenCalled();
			expect(consoleSpy.warn).toHaveBeenCalled();
			expect(consoleSpy.error).toHaveBeenCalled();
		});

		it('error filters all except error', () => {
			webLogger.setLevel('error');

			webLogger.debug('test');
			webLogger.info('test');
			webLogger.warn('test');
			webLogger.error('test');

			expect(consoleSpy.debug).not.toHaveBeenCalled();
			expect(consoleSpy.info).not.toHaveBeenCalled();
			expect(consoleSpy.warn).not.toHaveBeenCalled();
			expect(consoleSpy.error).toHaveBeenCalled();
		});
	});

	describe('window.__webLogger exposure', () => {
		it('exposes webLogger on window', () => {
			// The module exposes __webLogger when window is defined
			expect((window as any).__webLogger).toBe(webLogger);
		});
	});

	describe('edge cases', () => {
		beforeEach(() => {
			webLogger.setLevel('debug');
		});

		it('handles empty string message', () => {
			webLogger.debug('');
			expect(consoleSpy.debug).toHaveBeenCalledWith('[WebUI] ');
		});

		it('handles very long messages', () => {
			const longMessage = 'x'.repeat(10000);
			webLogger.debug(longMessage);
			expect(consoleSpy.debug).toHaveBeenCalledWith(`[WebUI] ${longMessage}`);
		});

		it('handles rapid logging calls', () => {
			for (let i = 0; i < 100; i++) {
				webLogger.debug(`message ${i}`);
			}
			expect(consoleSpy.debug).toHaveBeenCalledTimes(100);
		});

		it('handles all log methods in sequence', () => {
			webLogger.debug('1');
			webLogger.info('2');
			webLogger.warn('3');
			webLogger.error('4');

			expect(consoleSpy.debug).toHaveBeenCalledTimes(1);
			expect(consoleSpy.info).toHaveBeenCalledTimes(1);
			expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
			expect(consoleSpy.error).toHaveBeenCalledTimes(1);
		});

		it('maintains state across multiple configuration changes', () => {
			webLogger.setLevel('debug');
			expect(webLogger.getLevel()).toBe('debug');

			webLogger.setEnabled(false);
			expect(webLogger.isEnabled()).toBe(false);
			expect(webLogger.getLevel()).toBe('debug'); // Level unchanged

			webLogger.setLevel('error');
			expect(webLogger.getLevel()).toBe('error');
			expect(webLogger.isEnabled()).toBe(false); // Enabled unchanged

			webLogger.setEnabled(true);
			expect(webLogger.isEnabled()).toBe(true);
			expect(webLogger.getLevel()).toBe('error'); // Level unchanged
		});
	});

	describe('integration scenarios', () => {
		it('logs connection flow with different levels', () => {
			webLogger.setLevel('debug');

			webLogger.debug('Initializing connection', 'WebSocket');
			webLogger.info('Connected to server', 'WebSocket', { url: 'ws://localhost:3000' });
			webLogger.warn('Connection unstable', 'WebSocket', { latency: 500 });
			webLogger.error('Connection lost', 'WebSocket', { code: 1006 });

			expect(consoleSpy.debug).toHaveBeenCalledWith('[WebUI] [WebSocket] Initializing connection');
			expect(consoleSpy.info).toHaveBeenCalledWith('[WebUI] [WebSocket] Connected to server', {
				url: 'ws://localhost:3000',
			});
			expect(consoleSpy.warn).toHaveBeenCalledWith('[WebUI] [WebSocket] Connection unstable', {
				latency: 500,
			});
			expect(consoleSpy.error).toHaveBeenCalledWith('[WebUI] [WebSocket] Connection lost', {
				code: 1006,
			});
		});

		it('logs user actions with context', () => {
			webLogger.setLevel('info');

			webLogger.info('User clicked send', 'UI');
			webLogger.info('Command submitted', 'CommandInput', { command: 'help' });

			expect(consoleSpy.info).toHaveBeenCalledWith('[WebUI] [UI] User clicked send');
			expect(consoleSpy.info).toHaveBeenCalledWith('[WebUI] [CommandInput] Command submitted', {
				command: 'help',
			});
		});

		it('production-like logging with warnings only', () => {
			// Default level is warn - simulating production
			webLogger.debug('Should not appear'); // filtered
			webLogger.info('Should not appear'); // filtered
			webLogger.warn('Deprecation warning'); // appears
			webLogger.error('Critical error'); // appears

			expect(consoleSpy.debug).not.toHaveBeenCalled();
			expect(consoleSpy.info).not.toHaveBeenCalled();
			expect(consoleSpy.warn).toHaveBeenCalledWith('[WebUI] Deprecation warning');
			expect(consoleSpy.error).toHaveBeenCalledWith('[WebUI] Critical error');
		});

		it('development-like logging with debug enabled', () => {
			webLogger.enableDebug();

			webLogger.debug('Variable state', 'Debug', { x: 1, y: 2 });
			webLogger.info('Process started');
			webLogger.warn('Memory usage high', undefined, { usage: '90%' });
			webLogger.error('Unhandled exception', 'App', new Error('test'));

			expect(consoleSpy.debug).toHaveBeenCalled();
			expect(consoleSpy.info).toHaveBeenCalled();
			expect(consoleSpy.warn).toHaveBeenCalled();
			expect(consoleSpy.error).toHaveBeenCalled();
		});
	});
});
