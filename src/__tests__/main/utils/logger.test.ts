import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to test the Logger class, not the singleton
// The module exports both the class structure and a singleton instance
// We'll import and create fresh instances for testing

// First, let's check the module structure
// Since Logger is a class exported via singleton, we need to work with fresh instances

// Helper to create a fresh Logger instance for testing
// We'll do this by importing the class and creating new instances
// However, since only the singleton is exported, we'll need to work around this

// Actually, we can test the singleton but reset its state between tests
import type { LogLevel, LogEntry } from '../../../main/utils/logger';

// Dynamic import to get a fresh module each time
const getLogger = async () => {
	// Clear module cache to get fresh Logger instance
	vi.resetModules();
	const module = await import('../../../main/utils/logger');
	return module.logger;
};

describe('Logger', () => {
	let logger: Awaited<ReturnType<typeof getLogger>>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
	let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
	let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		// Get a fresh logger instance
		logger = await getLogger();

		// Clear logs to start fresh
		logger.clearLogs();

		// Reset to default log level
		logger.setLogLevel('info');

		// Reset to default max buffer
		logger.setMaxLogBuffer(1000);

		// Spy on console methods
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('Log Level Management', () => {
		it('should have default log level of info', async () => {
			expect(logger.getLogLevel()).toBe('info');
		});

		it('should allow setting log level', async () => {
			logger.setLogLevel('debug');
			expect(logger.getLogLevel()).toBe('debug');

			logger.setLogLevel('warn');
			expect(logger.getLogLevel()).toBe('warn');

			logger.setLogLevel('error');
			expect(logger.getLogLevel()).toBe('error');
		});

		it('should filter debug logs when level is info', async () => {
			logger.setLogLevel('info');
			logger.debug('debug message');

			expect(logger.getLogs()).toHaveLength(0);
		});

		it('should log debug messages when level is debug', async () => {
			logger.setLogLevel('debug');
			logger.debug('debug message');

			expect(logger.getLogs()).toHaveLength(1);
			expect(logger.getLogs()[0].level).toBe('debug');
		});

		it('should filter info logs when level is warn', async () => {
			logger.setLogLevel('warn');
			logger.info('info message');

			expect(logger.getLogs()).toHaveLength(0);
		});

		it('should filter info and warn logs when level is error', async () => {
			logger.setLogLevel('error');
			logger.info('info message');
			logger.warn('warn message');

			expect(logger.getLogs()).toHaveLength(0);
		});

		it('should log error messages at any level', async () => {
			logger.setLogLevel('error');
			logger.error('error message');

			expect(logger.getLogs()).toHaveLength(1);
			expect(logger.getLogs()[0].level).toBe('error');
		});
	});

	describe('Buffer Size Management', () => {
		it('should have default max buffer of 1000', async () => {
			expect(logger.getMaxLogBuffer()).toBe(1000);
		});

		it('should allow setting max buffer size', async () => {
			logger.setMaxLogBuffer(500);
			expect(logger.getMaxLogBuffer()).toBe(500);

			logger.setMaxLogBuffer(100);
			expect(logger.getMaxLogBuffer()).toBe(100);
		});

		it('should trim logs when buffer exceeds max size', async () => {
			logger.setMaxLogBuffer(5);

			// Add 7 logs
			for (let i = 1; i <= 7; i++) {
				logger.info(`message ${i}`);
			}

			const logs = logger.getLogs();
			expect(logs).toHaveLength(5);
			// Should keep the last 5 (messages 3-7)
			expect(logs[0].message).toBe('message 3');
			expect(logs[4].message).toBe('message 7');
		});

		it('should trim existing logs when max buffer is reduced', async () => {
			// Add 10 logs with default buffer
			for (let i = 1; i <= 10; i++) {
				logger.info(`message ${i}`);
			}

			expect(logger.getLogs()).toHaveLength(10);

			// Reduce buffer size
			logger.setMaxLogBuffer(5);

			const logs = logger.getLogs();
			expect(logs).toHaveLength(5);
			// Should keep the last 5
			expect(logs[0].message).toBe('message 6');
			expect(logs[4].message).toBe('message 10');
		});

		it('should not trim when max buffer is increased', async () => {
			logger.setMaxLogBuffer(5);

			for (let i = 1; i <= 5; i++) {
				logger.info(`message ${i}`);
			}

			logger.setMaxLogBuffer(10);

			expect(logger.getLogs()).toHaveLength(5);
		});
	});

	describe('Logging Methods', () => {
		describe('debug', () => {
			it('should log debug message with correct structure', async () => {
				logger.setLogLevel('debug');
				const beforeTime = Date.now();
				logger.debug('debug test');
				const afterTime = Date.now();

				const logs = logger.getLogs();
				expect(logs).toHaveLength(1);
				expect(logs[0].level).toBe('debug');
				expect(logs[0].message).toBe('debug test');
				expect(logs[0].timestamp).toBeGreaterThanOrEqual(beforeTime);
				expect(logs[0].timestamp).toBeLessThanOrEqual(afterTime);
			});

			it('should log debug with context', async () => {
				logger.setLogLevel('debug');
				logger.debug('debug test', 'TestContext');

				const logs = logger.getLogs();
				expect(logs[0].context).toBe('TestContext');
			});

			it('should log debug with data', async () => {
				logger.setLogLevel('debug');
				const testData = { key: 'value', count: 42 };
				logger.debug('debug test', 'TestContext', testData);

				const logs = logger.getLogs();
				expect(logs[0].data).toEqual(testData);
			});

			it('should output to console.log for debug level', async () => {
				logger.setLogLevel('debug');
				logger.debug('debug console test');

				expect(consoleLogSpy).toHaveBeenCalled();
				expect(consoleLogSpy.mock.calls[0][0]).toContain('[DEBUG]');
				expect(consoleLogSpy.mock.calls[0][0]).toContain('debug console test');
			});
		});

		describe('info', () => {
			it('should log info message with correct structure', async () => {
				logger.info('info test');

				const logs = logger.getLogs();
				expect(logs).toHaveLength(1);
				expect(logs[0].level).toBe('info');
				expect(logs[0].message).toBe('info test');
			});

			it('should log info with context', async () => {
				logger.info('info test', 'InfoContext');

				const logs = logger.getLogs();
				expect(logs[0].context).toBe('InfoContext');
			});

			it('should log info with data', async () => {
				const testData = ['item1', 'item2'];
				logger.info('info test', undefined, testData);

				const logs = logger.getLogs();
				expect(logs[0].data).toEqual(testData);
				expect(logs[0].context).toBeUndefined();
			});

			it('should output to console.info for info level', async () => {
				logger.info('info console test');

				expect(consoleInfoSpy).toHaveBeenCalled();
				expect(consoleInfoSpy.mock.calls[0][0]).toContain('[INFO]');
				expect(consoleInfoSpy.mock.calls[0][0]).toContain('info console test');
			});
		});

		describe('warn', () => {
			it('should log warn message with correct structure', async () => {
				logger.warn('warn test');

				const logs = logger.getLogs();
				expect(logs).toHaveLength(1);
				expect(logs[0].level).toBe('warn');
				expect(logs[0].message).toBe('warn test');
			});

			it('should log warn with context and data', async () => {
				logger.warn('warn test', 'WarnContext', { warning: true });

				const logs = logger.getLogs();
				expect(logs[0].context).toBe('WarnContext');
				expect(logs[0].data).toEqual({ warning: true });
			});

			it('should output to console.warn for warn level', async () => {
				logger.warn('warn console test');

				expect(consoleWarnSpy).toHaveBeenCalled();
				expect(consoleWarnSpy.mock.calls[0][0]).toContain('[WARN]');
				expect(consoleWarnSpy.mock.calls[0][0]).toContain('warn console test');
			});
		});

		describe('error', () => {
			it('should log error message with correct structure', async () => {
				logger.error('error test');

				const logs = logger.getLogs();
				expect(logs).toHaveLength(1);
				expect(logs[0].level).toBe('error');
				expect(logs[0].message).toBe('error test');
			});

			it('should log error with context and data', async () => {
				const errorData = new Error('test error');
				logger.error('error test', 'ErrorContext', errorData);

				const logs = logger.getLogs();
				expect(logs[0].context).toBe('ErrorContext');
				expect(logs[0].data).toBe(errorData);
			});

			it('should output to console.error for error level', async () => {
				logger.error('error console test');

				expect(consoleErrorSpy).toHaveBeenCalled();
				expect(consoleErrorSpy.mock.calls[0][0]).toContain('[ERROR]');
				expect(consoleErrorSpy.mock.calls[0][0]).toContain('error console test');
			});
		});

		describe('toast', () => {
			it('should log toast message with correct structure', async () => {
				logger.toast('toast test');

				const logs = logger.getLogs();
				expect(logs).toHaveLength(1);
				expect(logs[0].level).toBe('toast');
				expect(logs[0].message).toBe('toast test');
			});

			it('should always log toast regardless of log level', async () => {
				logger.setLogLevel('error');
				logger.toast('toast test');

				// Toast should be logged even though level is error
				const logs = logger.getLogs();
				expect(logs).toHaveLength(1);
				expect(logs[0].level).toBe('toast');
			});

			it('should log toast with context and data', async () => {
				logger.toast('toast test', 'ToastContext', { notification: true });

				const logs = logger.getLogs();
				expect(logs[0].context).toBe('ToastContext');
				expect(logs[0].data).toEqual({ notification: true });
			});

			it('should output to console.info for toast level', async () => {
				logger.toast('toast console test');

				expect(consoleInfoSpy).toHaveBeenCalled();
				expect(consoleInfoSpy.mock.calls[0][0]).toContain('[TOAST]');
				expect(consoleInfoSpy.mock.calls[0][0]).toContain('toast console test');
			});
		});

		describe('autorun', () => {
			it('should log autorun message with correct structure', async () => {
				logger.autorun('Auto Run started');

				const logs = logger.getLogs();
				expect(logs).toHaveLength(1);
				expect(logs[0].level).toBe('autorun');
				expect(logs[0].message).toBe('Auto Run started');
			});

			it('should always log autorun regardless of log level', async () => {
				logger.setLogLevel('error');
				logger.autorun('Auto Run started');

				// Autorun should be logged even though level is error
				const logs = logger.getLogs();
				expect(logs).toHaveLength(1);
				expect(logs[0].level).toBe('autorun');
			});

			it('should log autorun with context (session name)', async () => {
				logger.autorun('Auto Run started', 'MySession');

				const logs = logger.getLogs();
				expect(logs[0].context).toBe('MySession');
			});

			it('should log autorun with data (documents and task info)', async () => {
				const autorunData = {
					documents: ['phase-1.md', 'phase-2.md'],
					totalTasks: 10,
					loopEnabled: true,
					maxLoops: 3,
				};
				logger.autorun('Auto Run started', 'MySession', autorunData);

				const logs = logger.getLogs();
				expect(logs[0].data).toEqual(autorunData);
			});

			it('should output to console.info for autorun level', async () => {
				logger.autorun('Auto Run console test');

				expect(consoleInfoSpy).toHaveBeenCalled();
				expect(consoleInfoSpy.mock.calls[0][0]).toContain('[AUTORUN]');
				expect(consoleInfoSpy.mock.calls[0][0]).toContain('Auto Run console test');
			});

			it('should log autorun workflow events in sequence', async () => {
				// Simulate a typical Auto Run workflow
				logger.autorun('Auto Run started', 'TestSession', {
					documents: ['phase-1.md'],
					totalTasks: 3,
				});
				logger.autorun('Processing document: phase-1.md', 'TestSession');
				logger.autorun('Loop 1 completed', 'TestSession', { tasksCompleted: 3 });
				logger.autorun('Auto Run exiting: All tasks completed', 'TestSession');

				const logs = logger.getLogs();
				expect(logs).toHaveLength(4);
				expect(logs.every((l) => l.level === 'autorun')).toBe(true);
				expect(logs.every((l) => l.context === 'TestSession')).toBe(true);
				expect(logs[0].message).toBe('Auto Run started');
				expect(logs[3].message).toBe('Auto Run exiting: All tasks completed');
			});
		});
	});

	describe('Log Retrieval (getLogs)', () => {
		beforeEach(async () => {
			// Populate with test logs
			logger.setLogLevel('debug');
			logger.debug('debug 1', 'ContextA');
			logger.info('info 1', 'ContextA');
			logger.info('info 2', 'ContextB');
			logger.warn('warn 1', 'ContextB');
			logger.error('error 1', 'ContextA');
		});

		it('should return all logs without filter', async () => {
			const logs = logger.getLogs();
			expect(logs).toHaveLength(5);
		});

		it('should return copy of logs (not reference)', async () => {
			const logs1 = logger.getLogs();
			const logs2 = logger.getLogs();
			expect(logs1).not.toBe(logs2);
		});

		it('should filter by level', async () => {
			const warnAndAbove = logger.getLogs({ level: 'warn' });
			expect(warnAndAbove).toHaveLength(2);
			expect(warnAndAbove.every((l) => l.level === 'warn' || l.level === 'error')).toBe(true);
		});

		it('should filter by level - error only', async () => {
			const errorOnly = logger.getLogs({ level: 'error' });
			expect(errorOnly).toHaveLength(1);
			expect(errorOnly[0].level).toBe('error');
		});

		it('should filter by level - info and above', async () => {
			const infoAndAbove = logger.getLogs({ level: 'info' });
			expect(infoAndAbove).toHaveLength(4); // info, info, warn, error (no debug)
		});

		it('should filter by context', async () => {
			const contextA = logger.getLogs({ context: 'ContextA' });
			expect(contextA).toHaveLength(3);
			expect(contextA.every((l) => l.context === 'ContextA')).toBe(true);
		});

		it('should filter by context - different context', async () => {
			const contextB = logger.getLogs({ context: 'ContextB' });
			expect(contextB).toHaveLength(2);
			expect(contextB.every((l) => l.context === 'ContextB')).toBe(true);
		});

		it('should filter by context - non-existent context', async () => {
			const noContext = logger.getLogs({ context: 'NonExistent' });
			expect(noContext).toHaveLength(0);
		});

		it('should limit returned entries', async () => {
			const limited = logger.getLogs({ limit: 2 });
			expect(limited).toHaveLength(2);
			// Should return last 2
			expect(limited[0].level).toBe('warn');
			expect(limited[1].level).toBe('error');
		});

		it('should handle limit larger than log count', async () => {
			const limited = logger.getLogs({ limit: 100 });
			expect(limited).toHaveLength(5);
		});

		it('should combine level and context filters', async () => {
			const filtered = logger.getLogs({ level: 'info', context: 'ContextA' });
			expect(filtered).toHaveLength(2); // info 1 and error 1 from ContextA (info level and above)
		});

		it('should combine all filters', async () => {
			const filtered = logger.getLogs({ level: 'info', context: 'ContextA', limit: 1 });
			expect(filtered).toHaveLength(1);
			expect(filtered[0].level).toBe('error'); // Last one from ContextA at info level or above
		});
	});

	describe('Log Clearing (clearLogs)', () => {
		it('should clear all logs', async () => {
			logger.info('message 1');
			logger.info('message 2');
			logger.info('message 3');

			expect(logger.getLogs()).toHaveLength(3);

			logger.clearLogs();

			expect(logger.getLogs()).toHaveLength(0);
		});

		it('should allow new logs after clearing', async () => {
			logger.info('message 1');
			logger.clearLogs();
			logger.info('message 2');

			const logs = logger.getLogs();
			expect(logs).toHaveLength(1);
			expect(logs[0].message).toBe('message 2');
		});
	});

	describe('Console Output Formatting', () => {
		it('should include timestamp in ISO format', async () => {
			logger.info('test message');

			const logCall = consoleInfoSpy.mock.calls[0][0];
			// Should contain ISO timestamp format [YYYY-MM-DDTHH:MM:SS.sssZ]
			expect(logCall).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		});

		it('should include context in brackets when provided', async () => {
			logger.info('test message', 'MyContext');

			const logCall = consoleInfoSpy.mock.calls[0][0];
			expect(logCall).toContain('[MyContext]');
		});

		it('should not include context brackets when not provided', async () => {
			logger.info('test message');

			const logCall = consoleInfoSpy.mock.calls[0][0];
			// Should have only two bracket pairs: timestamp and level
			const bracketCount = (logCall.match(/\[/g) || []).length;
			expect(bracketCount).toBe(2);
		});

		it('should output data as second argument when provided', async () => {
			const testData = { key: 'value' };
			logger.info('test message', 'Context', testData);

			expect(consoleInfoSpy.mock.calls[0][1]).toEqual(testData);
		});

		it('should output empty string as second argument when no data', async () => {
			logger.info('test message');

			expect(consoleInfoSpy.mock.calls[0][1]).toBe('');
		});
	});

	describe('Edge Cases', () => {
		it('should handle empty message', async () => {
			logger.info('');

			const logs = logger.getLogs();
			expect(logs).toHaveLength(1);
			expect(logs[0].message).toBe('');
		});

		it('should handle undefined data', async () => {
			logger.info('test', 'Context', undefined);

			const logs = logger.getLogs();
			expect(logs[0].data).toBeUndefined();
		});

		it('should handle null data', async () => {
			logger.info('test', 'Context', null);

			const logs = logger.getLogs();
			expect(logs[0].data).toBeNull();
		});

		it('should handle complex nested data', async () => {
			const complexData = {
				array: [1, 2, 3],
				nested: { a: { b: { c: 'deep' } } },
				fn: undefined, // Functions would be undefined after JSON stringify
				date: new Date('2024-01-01'),
			};
			logger.info('test', undefined, complexData);

			const logs = logger.getLogs();
			expect(logs[0].data).toEqual(complexData);
		});

		it('should handle special characters in message', async () => {
			const specialMessage = 'Test: [brackets] {braces} "quotes" \'apostrophes\' \n newline \t tab';
			logger.info(specialMessage);

			const logs = logger.getLogs();
			expect(logs[0].message).toBe(specialMessage);
		});

		it('should handle unicode in message', async () => {
			const unicodeMessage = 'Test: 🔥 火 مرحبا 你好 emoji and scripts';
			logger.info(unicodeMessage);

			const logs = logger.getLogs();
			expect(logs[0].message).toBe(unicodeMessage);
		});

		it('should handle very long message', async () => {
			const longMessage = 'a'.repeat(10000);
			logger.info(longMessage);

			const logs = logger.getLogs();
			expect(logs[0].message).toBe(longMessage);
			expect(logs[0].message.length).toBe(10000);
		});
	});

	describe('Level Priority System', () => {
		it('should respect debug < info < warn < error priority', async () => {
			// At debug level, all messages should be logged
			logger.setLogLevel('debug');
			logger.debug('d');
			logger.info('i');
			logger.warn('w');
			logger.error('e');
			expect(logger.getLogs()).toHaveLength(4);
			logger.clearLogs();

			// At info level, debug should be filtered
			logger.setLogLevel('info');
			logger.debug('d');
			logger.info('i');
			logger.warn('w');
			logger.error('e');
			expect(logger.getLogs()).toHaveLength(3);
			logger.clearLogs();

			// At warn level, debug and info should be filtered
			logger.setLogLevel('warn');
			logger.debug('d');
			logger.info('i');
			logger.warn('w');
			logger.error('e');
			expect(logger.getLogs()).toHaveLength(2);
			logger.clearLogs();

			// At error level, only error should be logged
			logger.setLogLevel('error');
			logger.debug('d');
			logger.info('i');
			logger.warn('w');
			logger.error('e');
			expect(logger.getLogs()).toHaveLength(1);
			expect(logger.getLogs()[0].level).toBe('error');
		});

		it('should treat toast as info priority for filtering in getLogs', async () => {
			logger.toast('toast message');

			// Toast has priority 1 (same as info), so filtering by warn should exclude it
			const warnLevel = logger.getLogs({ level: 'warn' });
			expect(warnLevel).toHaveLength(0);

			// But filtering by info should include it
			const infoLevel = logger.getLogs({ level: 'info' });
			expect(infoLevel).toHaveLength(1);
		});

		it('should treat autorun as info priority for filtering in getLogs', async () => {
			logger.autorun('autorun message');

			// Autorun has priority 1 (same as info), so filtering by warn should exclude it
			const warnLevel = logger.getLogs({ level: 'warn' });
			expect(warnLevel).toHaveLength(0);

			// But filtering by info should include it
			const infoLevel = logger.getLogs({ level: 'info' });
			expect(infoLevel).toHaveLength(1);
		});

		it('should log both toast and autorun alongside regular levels', async () => {
			logger.setLogLevel('debug');
			logger.debug('debug');
			logger.info('info');
			logger.toast('toast');
			logger.autorun('autorun');
			logger.warn('warn');
			logger.error('error');

			const logs = logger.getLogs();
			expect(logs).toHaveLength(6);
			expect(logs.map((l) => l.level)).toEqual([
				'debug',
				'info',
				'toast',
				'autorun',
				'warn',
				'error',
			]);
		});
	});
});
