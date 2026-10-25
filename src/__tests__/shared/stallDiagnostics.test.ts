import { describe, expect, it } from 'vitest';
import { StallDiagnostics } from '../../shared/stallDiagnostics';

function monitor() {
	let now = 0;
	const diagnostics = new StallDiagnostics('main', () => now);
	diagnostics.start();
	return {
		diagnostics,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe('StallDiagnostics', () => {
	it('does not emit reports for a quiet reporting window', () => {
		const { diagnostics, advance } = monitor();
		const operation = diagnostics.beginOperation('fs:readDir');
		advance(100);
		diagnostics.endOperation(operation);
		diagnostics.recordStall(249);
		advance(4900);
		expect(diagnostics.drain()).toBeUndefined();
	});

	it('keeps asynchronous slowness distinct from an event-loop stall', () => {
		const { diagnostics, advance } = monitor();
		const operation = diagnostics.beginOperation('fs:directorySize');
		advance(2400);
		diagnostics.endOperation(operation);
		const report = diagnostics.drain();
		expect(report).toMatchObject({
			process: 'main',
			stallSamples: 0,
			maxDelayMs: 0,
			synchronousWork: [],
			slowOperations: [{ kind: 'ipc', name: 'fs:directorySize', count: 1, maxMs: 2400 }],
			activeOperations: [],
		});
	});

	it('records blocking work without changing its return value or thrown error', () => {
		const { diagnostics, advance } = monitor();
		const result = { value: 42 };
		expect(
			diagnostics.measureSynchronous('spawn', 'git', () => {
				advance(300);
				return result;
			})
		).toBe(result);
		const failure = new Error('original application failure');
		expect(() =>
			diagnostics.measureSynchronous('ipc', 'git:status', () => {
				advance(400);
				throw failure;
			})
		).toThrow(failure);
		const report = diagnostics.drain();
		expect(report?.maxDelayMs).toBe(400);
		expect(report?.synchronousWork).toEqual([
			{ kind: 'ipc', name: 'git:status', count: 1, totalMs: 400, maxMs: 400 },
			{ kind: 'spawn', name: 'git', count: 1, totalMs: 300, maxMs: 300 },
		]);
		expect(diagnostics.drain()).toBeUndefined();
	});

	it('reports an overdue operation once even if it stays pending or finishes later', () => {
		const { diagnostics, advance } = monitor();
		const operation = diagnostics.beginOperation('git:status');
		advance(5000);
		expect(diagnostics.drain()?.activeOperations).toEqual([
			{ name: 'git:status', elapsedMs: 5000 },
		]);
		advance(5000);
		expect(diagnostics.drain()).toBeUndefined();
		diagnostics.endOperation(operation);
		expect(diagnostics.drain()).toBeUndefined();
	});

	it('drops pre-suspend operations without confusing their late completions with new work', () => {
		const { diagnostics, advance } = monitor();
		const beforeSleep = diagnostics.beginOperation('before-sleep');
		advance(60000);
		diagnostics.reset();
		const afterSleep = diagnostics.beginOperation('after-sleep');
		diagnostics.endOperation(beforeSleep);
		advance(2500);
		diagnostics.endOperation(afterSleep);
		expect(diagnostics.drain()?.slowOperations).toEqual([
			{ kind: 'ipc', name: 'after-sleep', count: 1, totalMs: 2500, maxMs: 2500 },
		]);
	});

	it('bounds high-cardinality reports and signals incomplete operation coverage', () => {
		const { diagnostics, advance } = monitor();
		for (let i = 0; i < 1000; i++) {
			diagnostics.beginOperation(`request-${i}`);
			diagnostics.recordSynchronous('ipc', `request-${i}`, 10);
		}
		advance(5000);
		const report = diagnostics.drain()!;
		expect(report.activeOperations.length).toBeLessThanOrEqual(5);
		expect(report.synchronousWork.length).toBeLessThanOrEqual(5);
		expect(report.slowOperations.length).toBeLessThanOrEqual(5);
		expect(report.untrackedOperations).toBeGreaterThan(0);
		expect(report.synchronousWork.some((row) => row.name === '(other operations)')).toBe(true);
	});

	it('does not retain reports or operations across shutdown and restart', () => {
		const { diagnostics, advance } = monitor();
		const old = diagnostics.beginOperation('old');
		diagnostics.recordStall(500);
		diagnostics.stop();
		advance(10000);
		diagnostics.endOperation(old);
		expect(diagnostics.drain()).toBeUndefined();
		diagnostics.start();
		expect(diagnostics.drain()).toBeUndefined();
	});
});
