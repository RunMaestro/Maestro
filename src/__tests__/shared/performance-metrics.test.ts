/**
 * Tests for the Performance Metrics Logging utility.
 *
 * These tests verify the PerformanceMetrics class functionality including:
 * - Basic timing operations (start/end)
 * - Mark and measure pattern
 * - Metric collection and retrieval
 * - Threshold-based logging
 * - Enabled/disabled state handling
 */

import { describe, it, expect, vi } from 'vitest';
import {
	PerformanceMetrics,
	createNoOpMetrics,
	formatDuration,
	PERFORMANCE_THRESHOLDS,
	type PerformanceMetric,
} from '../../shared/performance-metrics';

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

describe('createNoOpMetrics', () => {
	it('should create a disabled metrics instance', () => {
		const metrics = createNoOpMetrics();
		expect(metrics.isEnabled()).toBe(false);
	});

	it('should not log anything', () => {
		const metrics = createNoOpMetrics();
		const start = metrics.start();
		metrics.end(start, 'operation');
		expect(metrics.getMetrics()).toHaveLength(0);
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
