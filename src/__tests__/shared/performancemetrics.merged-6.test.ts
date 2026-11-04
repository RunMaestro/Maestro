// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/shared/performance-metrics.test.ts
// Source: src/__tests__/shared/synopsis.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
	PerformanceMetrics,
	formatDuration,
	PERFORMANCE_THRESHOLDS,
	type PerformanceMetric,
} from '../../shared/performance-metrics';
import { parseSynopsis, NOTHING_TO_REPORT, isFailedSynopsisResponse } from '../../shared/synopsis';
// Source: src/__tests__/shared/performance-metrics.test.ts
describe('', () => {
	describe('PerformanceMetrics', () => {
		describe('initialization', () => {
			it('should create instance with context and logger', () => {
				const mockLogger = vi.fn();
				const metrics = new PerformanceMetrics('TestContext', mockLogger, false);
				expect(metrics).toBeInstanceOf(PerformanceMetrics);
				expect(metrics.isEnabled()).toBe(false);
			});
			it('should be disabled by default', () => {
				const metrics = new PerformanceMetrics('TestContext');
				expect(metrics.isEnabled()).toBe(false);
			});
			it('should accept enabled flag in constructor', () => {
				const metrics = new PerformanceMetrics('TestContext', console.debug, true);
				expect(metrics.isEnabled()).toBe(true);
			});
			it('should use console.debug as default logger', () => {
				const metrics = new PerformanceMetrics('TestContext');
				// No error means default logger was accepted
				expect(metrics).toBeDefined();
			});
		});
		describe('setEnabled/isEnabled', () => {
			it('should enable metrics when setEnabled(true) is called', () => {
				const metrics = new PerformanceMetrics('TestContext');
				expect(metrics.isEnabled()).toBe(false);
				metrics.setEnabled(true);
				expect(metrics.isEnabled()).toBe(true);
			});
			it('should disable metrics when setEnabled(false) is called', () => {
				const metrics = new PerformanceMetrics('TestContext', console.debug, true);
				expect(metrics.isEnabled()).toBe(true);
				metrics.setEnabled(false);
				expect(metrics.isEnabled()).toBe(false);
			});
		});
		describe('now()', () => {
			it('should return a number', () => {
				const metrics = new PerformanceMetrics('TestContext');
				const timestamp = metrics.now();
				expect(typeof timestamp).toBe('number');
			});
			it('should return increasing values over time', async () => {
				const metrics = new PerformanceMetrics('TestContext');
				const t1 = metrics.now();
				await new Promise((resolve) => setTimeout(resolve, 10));
				const t2 = metrics.now();
				expect(t2).toBeGreaterThan(t1);
			});
		});
		describe('start/end timing', () => {
			it('should measure elapsed time between start and end', async () => {
				const mockLogger = vi.fn();
				const metrics = new PerformanceMetrics('TestContext', mockLogger, true);
				const startTime = metrics.start();
				await new Promise((resolve) => setTimeout(resolve, 50));
				const duration = metrics.end(startTime, 'testOperation');
				// Duration should be at least 50ms (with some tolerance)
				expect(duration).toBeGreaterThanOrEqual(45);
				expect(duration).toBeLessThan(200);
			});
			it('should log the timing when enabled', () => {
				const mockLogger = vi.fn();
				const metrics = new PerformanceMetrics('TestContext', mockLogger, true);
				const startTime = metrics.start();
				metrics.end(startTime, 'testOperation');
				expect(mockLogger).toHaveBeenCalledTimes(1);
				expect(mockLogger.mock.calls[0][0]).toMatch(/\[PERF\] testOperation: \d+\.\d+ms/);
			});
			it('should NOT log when disabled', () => {
				const mockLogger = vi.fn();
				const metrics = new PerformanceMetrics('TestContext', mockLogger, false);
				const startTime = metrics.start();
				metrics.end(startTime, 'testOperation');
				expect(mockLogger).not.toHaveBeenCalled();
			});
			it('should include details in log when provided', () => {
				const mockLogger = vi.fn();
				const metrics = new PerformanceMetrics('TestContext', mockLogger, true);
				const startTime = metrics.start();
				metrics.end(startTime, 'testOperation', { count: 5, type: 'test' });
				expect(mockLogger).toHaveBeenCalledTimes(1);
				expect(mockLogger.mock.calls[0][0]).toContain('{"count":5,"type":"test"}');
			});
			it('should return duration even when disabled', () => {
				const metrics = new PerformanceMetrics('TestContext', console.debug, false);
				const startTime = metrics.start();
				const duration = metrics.end(startTime, 'testOperation');
				expect(typeof duration).toBe('number');
				expect(duration).toBeGreaterThanOrEqual(0);
			});
		});
		describe('mark and measure', () => {
			it('should create and measure between marks', () => {
				const mockLogger = vi.fn();
				const metrics = new PerformanceMetrics('TestContext', mockLogger, true);
				metrics.mark('start');
				metrics.mark('end');
				const duration = metrics.measure('operation', 'start', 'end');
				expect(typeof duration).toBe('number');
				expect(duration).toBeGreaterThanOrEqual(0);
				expect(mockLogger).toHaveBeenCalled();
			});
			it('should measure from mark to current time when endMark not provided', async () => {
				const mockLogger = vi.fn();
				const metrics = new PerformanceMetrics('TestContext', mockLogger, true);
				metrics.mark('start');
				await new Promise((resolve) => setTimeout(resolve, 20));
				const duration = metrics.measure('operation', 'start');
				expect(duration).toBeGreaterThanOrEqual(15);
			});
			it('should return 0 and log warning when start mark not found', () => {
				const mockLogger = vi.fn();
				const metrics = new PerformanceMetrics('TestContext', mockLogger, true);
				const duration = metrics.measure('operation', 'nonexistent');
				expect(duration).toBe(0);
				expect(mockLogger).toHaveBeenCalledWith(
					'Performance mark not found: nonexistent',
					'[TestContext]'
				);
			});
			it('should return 0 and log warning when end mark not found', () => {
				const mockLogger = vi.fn();
				const metrics = new PerformanceMetrics('TestContext', mockLogger, true);
				metrics.mark('start');
				const duration = metrics.measure('operation', 'start', 'nonexistent');
				expect(duration).toBe(0);
				expect(mockLogger).toHaveBeenCalledWith(
					'Performance mark not found: nonexistent',
					'[TestContext]'
				);
			});
			it('should not create marks when disabled', () => {
				const metrics = new PerformanceMetrics('TestContext', console.debug, false);
				metrics.mark('start');
				const duration = metrics.measure('operation', 'start');
				// When disabled, marks aren't recorded, so measure returns 0
				expect(duration).toBe(0);
			});
		});
		describe('clearMark/clearMarks', () => {
			it('should clear a specific mark', () => {
				const mockLogger = vi.fn();
				const metrics = new PerformanceMetrics('TestContext', mockLogger, true);
				metrics.mark('mark1');
				metrics.mark('mark2');
				metrics.clearMark('mark1');
				// mark1 should be gone
				const duration1 = metrics.measure('op1', 'mark1');
				expect(duration1).toBe(0);
				// mark2 should still exist
				const duration2 = metrics.measure('op2', 'mark2');
				expect(duration2).toBeGreaterThanOrEqual(0);
			});
			it('should clear all marks', () => {
				const mockLogger = vi.fn();
				const metrics = new PerformanceMetrics('TestContext', mockLogger, true);
				metrics.mark('mark1');
				metrics.mark('mark2');
				metrics.mark('mark3');
				metrics.clearMarks();
				// All marks should be gone
				expect(metrics.measure('op1', 'mark1')).toBe(0);
				expect(metrics.measure('op2', 'mark2')).toBe(0);
				expect(metrics.measure('op3', 'mark3')).toBe(0);
			});
		});
		describe('metrics collection', () => {
			it('should collect metrics when enabled', () => {
				const metrics = new PerformanceMetrics('TestContext', console.debug, true);
				const start = metrics.start();
				metrics.end(start, 'operation1');
				const collectedMetrics = metrics.getMetrics();
				expect(collectedMetrics).toHaveLength(1);
				expect(collectedMetrics[0].name).toBe('operation1');
			});
			it('should NOT collect metrics when disabled', () => {
				const metrics = new PerformanceMetrics('TestContext', console.debug, false);
				const start = metrics.start();
				metrics.end(start, 'operation1');
				const collectedMetrics = metrics.getMetrics();
				expect(collectedMetrics).toHaveLength(0);
			});
			it('should include timestamp in metrics', () => {
				const metrics = new PerformanceMetrics('TestContext', console.debug, true);
				const before = Date.now();
				const start = metrics.start();
				metrics.end(start, 'operation1');
				const after = Date.now();
				const collectedMetrics = metrics.getMetrics();
				expect(collectedMetrics[0].timestamp).toBeGreaterThanOrEqual(before);
				expect(collectedMetrics[0].timestamp).toBeLessThanOrEqual(after);
			});
			it('should include context in metrics', () => {
				const metrics = new PerformanceMetrics('MyComponent', console.debug, true);
				const start = metrics.start();
				metrics.end(start, 'operation1');
				const collectedMetrics = metrics.getMetrics();
				expect(collectedMetrics[0].context).toBe('MyComponent');
			});
			it('should include details in metrics', () => {
				const metrics = new PerformanceMetrics('TestContext', console.debug, true);
				const start = metrics.start();
				metrics.end(start, 'operation1', { key: 'value' });
				const collectedMetrics = metrics.getMetrics();
				expect(collectedMetrics[0].details).toEqual({ key: 'value' });
			});
			it('should limit collected metrics to maxMetrics', () => {
				const metrics = new PerformanceMetrics('TestContext', console.debug, true);
				// Record more than 100 metrics (default max)
				for (let i = 0; i < 120; i++) {
					const start = metrics.start();
					metrics.end(start, `operation${i}`);
				}
				const collectedMetrics = metrics.getMetrics();
				expect(collectedMetrics.length).toBeLessThanOrEqual(100);
				// Should keep the most recent metrics
				expect(collectedMetrics[collectedMetrics.length - 1].name).toBe('operation119');
			});
		});
		describe('getMetricsByName', () => {
			it('should filter metrics by exact name', () => {
				const metrics = new PerformanceMetrics('TestContext', console.debug, true);
				const start1 = metrics.start();
				metrics.end(start1, 'operation1');
				const start2 = metrics.start();
				metrics.end(start2, 'operation2');
				const filtered = metrics.getMetricsByName('operation1');
				expect(filtered).toHaveLength(1);
				expect(filtered[0].name).toBe('operation1');
			});
			it('should support glob patterns with *', () => {
				const metrics = new PerformanceMetrics('TestContext', console.debug, true);
				const start1 = metrics.start();
				metrics.end(start1, 'getStats:totals');
				const start2 = metrics.start();
				metrics.end(start2, 'getStats:byAgent');
				const start3 = metrics.start();
				metrics.end(start3, 'other');
				const filtered = metrics.getMetricsByName('getStats:*');
				expect(filtered).toHaveLength(2);
			});
		});
		describe('getAverageDuration', () => {
			it('should calculate average duration for matching metrics', () => {
				const metrics = new PerformanceMetrics('TestContext', console.debug, true);
				// Create metrics with known durations by mocking
				// Since we can't easily control duration, we'll test the calculation
				const start1 = metrics.start();
				metrics.end(start1, 'test');
				const start2 = metrics.start();
				metrics.end(start2, 'test');
				const avg = metrics.getAverageDuration('test');
				expect(typeof avg).toBe('number');
				expect(avg).toBeGreaterThanOrEqual(0);
			});
			it('should return 0 when no metrics match', () => {
				const metrics = new PerformanceMetrics('TestContext', console.debug, true);
				const avg = metrics.getAverageDuration('nonexistent');
				expect(avg).toBe(0);
			});
		});
		describe('clearMetrics', () => {
			it('should clear all collected metrics', () => {
				const metrics = new PerformanceMetrics('TestContext', console.debug, true);
				const start = metrics.start();
				metrics.end(start, 'operation1');
				expect(metrics.getMetrics()).toHaveLength(1);
				metrics.clearMetrics();
				expect(metrics.getMetrics()).toHaveLength(0);
			});
		});
		describe('timeAsync', () => {
			it('should time an async function', async () => {
				const mockLogger = vi.fn();
				const metrics = new PerformanceMetrics('TestContext', mockLogger, true);
				const result = await metrics.timeAsync('asyncOp', async () => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					return 'result';
				});
				expect(result).toBe('result');
				expect(mockLogger).toHaveBeenCalled();
				expect(mockLogger.mock.calls[0][0]).toMatch(/\[PERF\] asyncOp: \d+\.\d+ms/);
			});
			it('should time async function even when it throws', async () => {
				const mockLogger = vi.fn();
				const metrics = new PerformanceMetrics('TestContext', mockLogger, true);
				await expect(
					metrics.timeAsync('asyncOp', async () => {
						throw new Error('test error');
					})
				).rejects.toThrow('test error');
				// Should still log the timing
				expect(mockLogger).toHaveBeenCalled();
			});
		});
		describe('timeSync', () => {
			it('should time a sync function', () => {
				const mockLogger = vi.fn();
				const metrics = new PerformanceMetrics('TestContext', mockLogger, true);
				const result = metrics.timeSync('syncOp', () => {
					let sum = 0;
					for (let i = 0; i < 1000; i++) {
						sum += i;
					}
					return sum;
				});
				expect(result).toBe(499500);
				expect(mockLogger).toHaveBeenCalled();
			});
			it('should time sync function even when it throws', () => {
				const mockLogger = vi.fn();
				const metrics = new PerformanceMetrics('TestContext', mockLogger, true);
				expect(() =>
					metrics.timeSync('syncOp', () => {
						throw new Error('test error');
					})
				).toThrow('test error');
				// Should still log the timing
				expect(mockLogger).toHaveBeenCalled();
			});
		});
	});
	describe('formatDuration', () => {
		it('should format milliseconds correctly', () => {
			expect(formatDuration(0)).toBe('0.00ms');
			expect(formatDuration(1.5)).toBe('1.50ms');
			expect(formatDuration(123.456)).toBe('123.46ms');
			expect(formatDuration(999)).toBe('999.00ms');
		});
		it('should format seconds correctly', () => {
			expect(formatDuration(1000)).toBe('1.00s');
			expect(formatDuration(1234)).toBe('1.23s');
			expect(formatDuration(60000)).toBe('60.00s');
		});
	});
	describe('PERFORMANCE_THRESHOLDS', () => {
		it('should define expected thresholds', () => {
			expect(PERFORMANCE_THRESHOLDS.DASHBOARD_LOAD).toBe(200);
			expect(PERFORMANCE_THRESHOLDS.SQL_QUERY).toBe(50);
			expect(PERFORMANCE_THRESHOLDS.GRAPH_BUILD_SMALL).toBe(1000);
			expect(PERFORMANCE_THRESHOLDS.GRAPH_BUILD_LARGE).toBe(3000);
			expect(PERFORMANCE_THRESHOLDS.LAYOUT_ALGORITHM).toBe(500);
			expect(PERFORMANCE_THRESHOLDS.REACT_RENDER).toBe(16);
		});
		it('should have numeric threshold values', () => {
			// All thresholds should be positive numbers
			for (const [key, value] of Object.entries(PERFORMANCE_THRESHOLDS)) {
				expect(typeof value).toBe('number');
				expect(value).toBeGreaterThan(0);
			}
		});
	});
	describe('PerformanceMetric interface', () => {
		it('should have expected properties', () => {
			const metrics = new PerformanceMetrics('TestContext', console.debug, true);
			const start = metrics.start();
			metrics.end(start, 'operation', { detail: 'value' });
			const collected = metrics.getMetrics();
			expect(collected).toHaveLength(1);
			const metric: PerformanceMetric = collected[0];
			expect(metric).toHaveProperty('name', 'operation');
			expect(metric).toHaveProperty('durationMs');
			expect(metric).toHaveProperty('timestamp');
			expect(metric).toHaveProperty('context', 'TestContext');
			expect(metric).toHaveProperty('details', { detail: 'value' });
		});
	});
});
// Source: src/__tests__/shared/synopsis.test.ts
describe('', () => {
	// Local alias mirroring the (now-internal) ParsedSynopsis shape returned by
	// parseSynopsis. Kept in sync with shared/synopsis.ts.
	type ParsedSynopsis = ReturnType<typeof parseSynopsis>;
	describe('synopsis', () => {
		describe('parseSynopsis', () => {
			describe('proper format parsing', () => {
				it('should parse response with Summary and Details sections', () => {
					const response =
						'**Summary:** Fixed the authentication bug\n\n**Details:** Updated the login handler to properly validate tokens and handle edge cases.';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Fixed the authentication bug');
					expect(result.fullSynopsis).toBe(
						'Fixed the authentication bug\n\nUpdated the login handler to properly validate tokens and handle edge cases.'
					);
					expect(result.nothingToReport).toBe(false);
				});
				it('should parse response with Summary only', () => {
					const response = '**Summary:** No changes made.';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('No changes made.');
					expect(result.fullSynopsis).toBe('No changes made.');
					expect(result.nothingToReport).toBe(false);
				});
				it('should handle case-insensitive section headers', () => {
					const response = '**SUMMARY:** All tests pass\n\n**DETAILS:** Ran full test suite.';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('All tests pass');
					expect(result.fullSynopsis).toBe('All tests pass\n\nRan full test suite.');
				});
				it('should handle multiline Details section', () => {
					const response = `**Summary:** Refactored component

**Details:** Made several changes:
- Updated state management
- Fixed prop types
- Added new tests`;
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Refactored component');
					expect(result.fullSynopsis).toContain('Made several changes:');
					expect(result.fullSynopsis).toContain('- Updated state management');
				});
			});
			describe('ANSI code cleaning', () => {
				it('should strip ANSI color codes', () => {
					const response = '\x1b[32m**Summary:**\x1b[0m Test passed\n\n**Details:** All green.';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Test passed');
					expect(result.fullSynopsis).toBe('Test passed\n\nAll green.');
				});
				it('should handle multiple ANSI codes', () => {
					const response = '\x1b[1m\x1b[36m**Summary:**\x1b[0m \x1b[33mWarning handled\x1b[0m';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Warning handled');
				});
				it('should handle complex ANSI sequences', () => {
					const response = '\x1b[38;5;196m**Summary:**\x1b[0m Critical fix applied';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Critical fix applied');
				});
			});
			describe('box drawing character cleaning', () => {
				it('should strip horizontal box lines', () => {
					const response = '─────────────────\n**Summary:** Task complete\n─────────────────';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Task complete');
				});
				it('should strip vertical box characters', () => {
					const response = '│**Summary:** Task done│';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Task done');
				});
				it('should strip corner and junction box characters', () => {
					const response = '┌──────────┐\n│**Summary:** Test│\n└──────────┘';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Test');
				});
				it('should strip mixed box drawing characters', () => {
					const response = '├──┬──┤\n│**Summary:** Mixed box│\n├──┴──┤';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Mixed box');
				});
			});
			describe('combined ANSI and box character cleaning', () => {
				it('should clean both ANSI codes and box characters together', () => {
					const response =
						'\x1b[32m───────────────────\x1b[0m\n│**Summary:** Test summary│\n└──────────────────┘';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Test summary');
				});
			});
			describe('conversational filler filtering', () => {
				it('should skip "Excellent!" and use next meaningful line', () => {
					const response = 'Excellent!\n\nThe markdown generation is working perfectly.';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('The markdown generation is working perfectly.');
				});
				it('should skip "Perfect!" and use next meaningful line', () => {
					const response = 'Perfect!\n\nAll tests are passing now.';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('All tests are passing now.');
				});
				it('should skip multiple filler words at start', () => {
					const response = 'Great!\n\nExcellent!\n\nFixed the authentication bug in login handler.';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Fixed the authentication bug in login handler.');
				});
				it('should skip filler with exclamation marks and variations', () => {
					const fillers = [
						'Excellent!',
						'Perfect!',
						'Great!',
						'Awesome!',
						'Done!',
						'Wonderful!',
						'Fantastic!',
					];
					for (const filler of fillers) {
						const response = `${filler}\n\nActual content here.`;
						const result = parseSynopsis(response);
						expect(result.shortSummary).toBe('Actual content here.');
					}
				});
				it('should skip phrase fillers like "Looks good!"', () => {
					const response = 'Looks good!\n\nUpdated the config file with new settings.';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Updated the config file with new settings.');
				});
				it('should skip "All done!" style fillers', () => {
					const response = 'All done!\n\nRefactored the component to use hooks.';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Refactored the component to use hooks.');
				});
				it('should fall back to "Task completed" if only filler exists', () => {
					const response = 'Excellent!';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Task completed');
				});
			});
			describe('Details-headline rescue', () => {
				it('should promote bolded Details headline when Summary ends with "Task complete."', () => {
					const response =
						'**Summary:** The playbook file is gitignored - no commit needed for that. Task complete.\n\n**Details:** **Added maestro-p session-id discovery (session-watcher.ts)** - phase 1, task 6 of the maestro-p playbook.';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe(
						'Added maestro-p session-id discovery (session-watcher.ts)'
					);
					// Body is preserved as-is so HistoryDetailModal continues to show
					// the model's original formatting.
					expect(result.fullSynopsis).toContain('phase 1, task 6 of the maestro-p playbook');
					expect(result.fullSynopsis).toContain('**Added maestro-p');
				});
				it('should promote bolded Details headline when Summary is "Checkbox flipped..."', () => {
					const response =
						'**Summary:** Checkbox flipped to [x]. Task done.\n\n**Details:** **Implemented the maestro-p stream-json emitter (phase 1, task 5)** with full event coverage.';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe(
						'Implemented the maestro-p stream-json emitter (phase 1, task 5)'
					);
					expect(result.fullSynopsis).toContain('full event coverage');
				});
				it('should promote markdown heading from Details when Summary is "Pushed cleanly..."', () => {
					const response =
						'**Summary:** Pushed cleanly. Per playbook instructions, I exit after one task.\n\n**Details:** ## Implemented the maestro-p TUI driver core (phase 1 task 3)\nThe new TuiDriver class spawns claude via node-pty.';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe(
						'Implemented the maestro-p TUI driver core (phase 1 task 3)'
					);
					expect(result.fullSynopsis).toContain('spawns claude via node-pty');
				});
				it('should leave wrap-up Summary alone when Details has no leading headline', () => {
					const response =
						'**Summary:** Task complete.\n\n**Details:** Updated the config file with new timeouts.';
					const result = parseSynopsis(response);
					// No headline to promote, so wrap-up Summary stays as-is rather than
					// falling all the way to the generic "Task completed" default.
					expect(result.shortSummary).toBe('Task complete.');
					expect(result.fullSynopsis).toContain('Updated the config file');
				});
				it('should not promote when Summary is already strong', () => {
					const response =
						'**Summary:** Fixed login validation bug in auth handler\n\n**Details:** **Some secondary heading** with more detail.';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Fixed login validation bug in auth handler');
					// Details preserved verbatim since Summary was fine
					expect(result.fullSynopsis).toContain('**Some secondary heading**');
				});
				it('should skip bolded labels like "**Note:**" - not headlines', () => {
					const response =
						'**Summary:** Task complete.\n\n**Details:** **Note:** all tests pass after the migration.';
					const result = parseSynopsis(response);
					// "Note:" is a label, not a headline - no promotion
					expect(result.shortSummary).toBe('Task complete.');
				});
			});
			describe('fallback behavior', () => {
				it('should use first line as summary when no format detected', () => {
					const response = 'Just a plain text response\nWith multiple lines.\nAnd more content.';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Just a plain text response');
					expect(result.fullSynopsis).toBe('Just a plain text response');
				});
				it('should handle single line without format', () => {
					const response = 'Single line response without format markers';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Single line response without format markers');
					expect(result.fullSynopsis).toBe('Single line response without format markers');
				});
				it('should return default message for empty string', () => {
					const response = '';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Task completed');
					expect(result.fullSynopsis).toBe('Task completed');
				});
				it('should return default message for whitespace-only string', () => {
					const response = '   \n\t\n   ';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Task completed');
					expect(result.fullSynopsis).toBe('Task completed');
				});
				it('should handle response with only box characters', () => {
					const response = '───────────────────\n│││\n───────────────────';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Task completed');
				});
			});
			describe('edge cases', () => {
				it('should handle Summary followed immediately by text (no newline before Details)', () => {
					const response = '**Summary:** Quick fix**Details:** No newline separator';
					const result = parseSynopsis(response);
					// Summary should capture up to Details marker
					expect(result.shortSummary).toBe('Quick fix');
				});
				it('should handle extra whitespace around sections', () => {
					const response = '**Summary:**   Lots of spaces   \n\n\n**Details:**   Also spaced   ';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Lots of spaces');
					expect(result.fullSynopsis).toContain('Also spaced');
				});
				it('should handle unicode in content', () => {
					const response =
						'**Summary:** Added emoji support 🎉\n\n**Details:** Now supports émojis and ünïcödë.';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Added emoji support 🎉');
					expect(result.fullSynopsis).toContain('émojis and ünïcödë');
				});
				it('should handle markdown formatting in content', () => {
					const response =
						'**Summary:** Updated `config.ts` file\n\n**Details:** Changed `timeout` from **500ms** to *1000ms*.';
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe('Updated `config.ts` file');
					expect(result.fullSynopsis).toContain('Changed `timeout`');
				});
				it('should handle very long summary text', () => {
					const longText = 'A'.repeat(500);
					const response = `**Summary:** ${longText}\n\n**Details:** Short details.`;
					const result = parseSynopsis(response);
					expect(result.shortSummary).toBe(longText);
					expect(result.fullSynopsis).toContain('Short details.');
				});
				it('should handle newlines within sections', () => {
					const response = `**Summary:** First line of summary
second line still summary

**Details:** Detail line one
detail line two`;
					const result = parseSynopsis(response);
					expect(result.shortSummary).toContain('First line of summary');
					expect(result.fullSynopsis).toContain('Detail line one');
				});
			});
			describe('return type validation', () => {
				it('should always return object with shortSummary, fullSynopsis, and nothingToReport', () => {
					const result = parseSynopsis('test');
					expect(result).toHaveProperty('shortSummary');
					expect(result).toHaveProperty('fullSynopsis');
					expect(result).toHaveProperty('nothingToReport');
					expect(typeof result.shortSummary).toBe('string');
					expect(typeof result.fullSynopsis).toBe('string');
					expect(typeof result.nothingToReport).toBe('boolean');
				});
				it('should satisfy ParsedSynopsis interface', () => {
					const result: ParsedSynopsis = parseSynopsis('**Summary:** Test');
					// TypeScript ensures interface compliance at compile time
					// Runtime check that properties exist
					expect(result.shortSummary).toBeDefined();
					expect(result.fullSynopsis).toBeDefined();
					expect(result.nothingToReport).toBe(false);
				});
			});
			describe('NOTHING_TO_REPORT detection', () => {
				it('should detect NOTHING_TO_REPORT token and return nothingToReport: true', () => {
					const result = parseSynopsis('NOTHING_TO_REPORT');
					expect(result.nothingToReport).toBe(true);
					expect(result.shortSummary).toBe('');
					expect(result.fullSynopsis).toBe('');
				});
				it('should detect NOTHING_TO_REPORT with surrounding whitespace', () => {
					const result = parseSynopsis('  \n  NOTHING_TO_REPORT  \n  ');
					expect(result.nothingToReport).toBe(true);
					expect(result.shortSummary).toBe('');
					expect(result.fullSynopsis).toBe('');
				});
				it('should detect NOTHING_TO_REPORT with ANSI codes', () => {
					const result = parseSynopsis('\x1b[32mNOTHING_TO_REPORT\x1b[0m');
					expect(result.nothingToReport).toBe(true);
				});
				it('should detect NOTHING_TO_REPORT with box drawing characters', () => {
					const result = parseSynopsis('───────\n│NOTHING_TO_REPORT│\n───────');
					expect(result.nothingToReport).toBe(true);
				});
				it('should return nothingToReport: false for normal synopsis', () => {
					const result = parseSynopsis('**Summary:** Fixed the bug\n\n**Details:** Updated code.');
					expect(result.nothingToReport).toBe(false);
					expect(result.shortSummary).toBe('Fixed the bug');
				});
				it('should return nothingToReport: false for empty responses', () => {
					// Empty responses should fall back to "Task completed", not NOTHING_TO_REPORT
					const result = parseSynopsis('');
					expect(result.nothingToReport).toBe(false);
					expect(result.shortSummary).toBe('Task completed');
				});
			});
		});
		describe('NOTHING_TO_REPORT constant', () => {
			it('should be the expected string value', () => {
				expect(NOTHING_TO_REPORT).toBe('NOTHING_TO_REPORT');
			});
		});
	});
	describe('isFailedSynopsisResponse', () => {
		it('treats a bare provider error as a failure', () => {
			// `claude -p` prints the API error and exits, so the run still produces
			// stdout. Parsed as prose it becomes the History entry for the turn.
			expect(isFailedSynopsisResponse('Prompt is too long')).toBe(true);
			expect(isFailedSynopsisResponse('prompt is too long: 206491 tokens > 200000 maximum')).toBe(
				true
			);
		});
		it('treats empty output as a failure', () => {
			expect(isFailedSynopsisResponse('')).toBe(true);
			expect(isFailedSynopsisResponse('   \n  ')).toBe(true);
		});
		it('does not mistake a synopsis ABOUT an error for an error', () => {
			// The error bank matches phrases that appear legitimately in prose, so
			// the length guard is what keeps a real synopsis out of the failure path.
			const synopsis =
				'**Summary:** Fixed the "Prompt is too long" failure in background synopsis runs.\n\n' +
				'**Details:** The synopsis resumed the tab transcript on a cheap 200k model while the ' +
				"agent itself runs Anthropic's 1M beta, so any conversation past 200k tokens failed " +
				'to replay. The spawn now keeps the tab model whenever the cheap tier would shrink the ' +
				'context window, and a failed run is reported as failed rather than written to History.';
			expect(isFailedSynopsisResponse(synopsis)).toBe(false);
		});
		it('accepts an ordinary short synopsis', () => {
			expect(isFailedSynopsisResponse('**Summary:** Rebased rc onto main.')).toBe(false);
		});
	});
});
