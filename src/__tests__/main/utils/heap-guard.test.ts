// @vitest-environment node
/**
 * The heap guard exists because the crash it reports cannot be caught.
 *
 * A main-process V8 heap exhaustion is an abort: no exception, no unwind, no
 * `uncaughtException`, and no chance to report anything afterwards. So the only
 * available signal is a warning sent BEFORE the abort, which is what these
 * tests pin down - that it fires when the heap gets dangerous, that it fires at
 * most once, and above all that it never changes what the guarded work does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captureMessage = vi.fn().mockResolvedValue(undefined);
const warn = vi.fn();
const info = vi.fn();

vi.mock('../../../main/utils/sentry', () => ({
	captureMessage: (...args: unknown[]) => captureMessage(...args),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		warn: (...args: unknown[]) => warn(...args),
		info: (...args: unknown[]) => info(...args),
		debug: vi.fn(),
		error: vi.fn(),
	},
}));

import v8 from 'v8';
import { HEAP_DANGER_FRACTION, sampleHeap, withHeapGuard } from '../../../main/utils/heap-guard';

/** Pretend the heap sits at `fraction` of a 4 GB ceiling. */
function fakeHeapAt(fraction: number) {
	const limit = 4 * 1024 * 1024 * 1024;
	vi.spyOn(v8, 'getHeapStatistics').mockReturnValue({
		heap_size_limit: limit,
	} as ReturnType<typeof v8.getHeapStatistics>);
	vi.spyOn(process, 'memoryUsage').mockReturnValue({
		heapUsed: limit * fraction,
		rss: limit * fraction,
		heapTotal: limit,
		external: 0,
		arrayBuffers: 0,
	} as ReturnType<typeof process.memoryUsage>);
}

/** Let the guard's sampler tick at least once. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 400));

beforeEach(() => {
	captureMessage.mockClear();
	warn.mockClear();
	info.mockClear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('sampleHeap', () => {
	it('reports usage against the real V8 ceiling', () => {
		// The ceiling is what matters: 3 GB is fine on a 16 GB limit and fatal
		// on a 4 GB one, so a fixed megabyte threshold would be wrong on both.
		const sample = sampleHeap();
		expect(sample.heapLimitMB).toBeGreaterThan(0);
		expect(sample.fraction).toBeGreaterThan(0);
		expect(sample.fraction).toBeLessThanOrEqual(1);
	});
});

describe('withHeapGuard', () => {
	it('returns the work result untouched', async () => {
		fakeHeapAt(0.1);
		const result = await withHeapGuard({ operation: 'test' }, async () => 'value');
		expect(result).toBe('value');
	});

	it('propagates a rejection rather than swallowing it', async () => {
		fakeHeapAt(0.1);
		await expect(
			withHeapGuard({ operation: 'test' }, async () => {
				throw new Error('inner failure');
			})
		).rejects.toThrow('inner failure');
	});

	it('stays silent while the heap is comfortable', async () => {
		fakeHeapAt(0.2);
		await withHeapGuard({ operation: 'parquet:query' }, async () => {
			await tick();
		});
		expect(captureMessage).not.toHaveBeenCalled();
	});

	it('reports to Sentry when the heap crosses the danger line', async () => {
		fakeHeapAt(HEAP_DANGER_FRACTION + 0.1);
		await withHeapGuard({ operation: 'parquet:query', detail: { columns: 117 } }, async () => {
			await tick();
		});

		expect(captureMessage).toHaveBeenCalled();
		const [message, level, extra] = captureMessage.mock.calls[0];
		expect(message).toContain('parquet:query');
		expect(level).toBe('warning');
		// The operation and the shape of its input are the entire diagnostic
		// value: without them the report says only "memory was high".
		expect(extra).toMatchObject({ operation: 'parquet:query', columns: 117 });
		expect(extra.heapLimitMB).toBeGreaterThan(0);
	});

	it('reports at most once per guarded call', async () => {
		// The moment this fires is the moment the process can least afford
		// extra work, and a report per sample would be a flood.
		fakeHeapAt(0.95);
		await withHeapGuard({ operation: 'parquet:query' }, async () => {
			await tick();
			await tick();
			await tick();
		});
		expect(captureMessage).toHaveBeenCalledTimes(1);
	});

	it('sends the report DURING the work, not after it', async () => {
		// The whole design rests on this. If the report only went out after the
		// work returned, it would never be sent for the run that aborts - which
		// is precisely the run worth hearing about.
		fakeHeapAt(0.95);
		let sentBeforeWorkFinished = false;
		await withHeapGuard({ operation: 'parquet:query' }, async () => {
			await tick();
			sentBeforeWorkFinished = captureMessage.mock.calls.length > 0;
		});
		expect(sentBeforeWorkFinished).toBe(true);
	});

	it('logs a warning alongside the Sentry event', async () => {
		// Sentry may be unconfigured in development; the local log is what makes
		// this debuggable there.
		fakeHeapAt(0.9);
		await withHeapGuard({ operation: 'parquet:query' }, async () => {
			await tick();
		});
		expect(warn).toHaveBeenCalled();
		expect(String(warn.mock.calls[0][0])).toContain('Heap pressure');
	});

	it('skips guarding when no heap ceiling is reported', async () => {
		// Without a limit there is nothing to compare against, so watching would
		// produce noise rather than signal.
		vi.spyOn(v8, 'getHeapStatistics').mockReturnValue({
			heap_size_limit: 0,
		} as ReturnType<typeof v8.getHeapStatistics>);

		const result = await withHeapGuard({ operation: 'test' }, async () => {
			await tick();
			return 'ok';
		});

		expect(result).toBe('ok');
		expect(captureMessage).not.toHaveBeenCalled();
	});

	it('stops sampling once the work is done', async () => {
		// A leaked interval would keep sampling for the life of the process and
		// eventually report against work that had long since finished.
		fakeHeapAt(0.95);
		await withHeapGuard({ operation: 'parquet:query' }, async () => {
			await tick();
		});
		const afterWork = captureMessage.mock.calls.length;

		await tick();
		await tick();
		expect(captureMessage.mock.calls.length).toBe(afterWork);
	});

	it('stops sampling even when the work throws', async () => {
		fakeHeapAt(0.95);
		await expect(
			withHeapGuard({ operation: 'parquet:query' }, async () => {
				await tick();
				throw new Error('boom');
			})
		).rejects.toThrow('boom');

		const afterWork = captureMessage.mock.calls.length;
		await tick();
		await tick();
		expect(captureMessage.mock.calls.length).toBe(afterWork);
	});
});
