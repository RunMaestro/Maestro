import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import {
	armStdioCloseWatchdog,
	STDIO_CLOSE_GRACE_MS,
} from '../../../../main/process-manager/utils/stdioCloseWatchdog';

function makeStream() {
	return Object.assign(new EventEmitter(), {
		destroyed: false,
		destroy: vi.fn(function (this: { destroyed: boolean }) {
			this.destroyed = true;
		}),
	});
}

function makeChild() {
	return Object.assign(new EventEmitter(), {
		stdin: makeStream(),
		stdout: makeStream(),
		stderr: makeStream(),
	});
}

describe('armStdioCloseWatchdog', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('destroys stdio when close never follows exit', () => {
		const child = makeChild();
		const onForceClose = vi.fn();
		armStdioCloseWatchdog(child as any, { onForceClose });

		child.emit('exit', null, 'SIGINT');
		vi.advanceTimersByTime(STDIO_CLOSE_GRACE_MS - 1);
		expect(child.stdout.destroy).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(onForceClose).toHaveBeenCalledTimes(1);
		expect(child.stdin.destroy).toHaveBeenCalled();
		expect(child.stdout.destroy).toHaveBeenCalled();
		expect(child.stderr.destroy).toHaveBeenCalled();
	});

	it('does nothing when close arrives within the grace period', () => {
		const child = makeChild();
		const onForceClose = vi.fn();
		armStdioCloseWatchdog(child as any, { onForceClose });

		child.emit('exit', 0, null);
		child.emit('close', 0);
		vi.advanceTimersByTime(STDIO_CLOSE_GRACE_MS * 2);

		expect(onForceClose).not.toHaveBeenCalled();
		expect(child.stdout.destroy).not.toHaveBeenCalled();
	});

	it('never arms while the child is still running', () => {
		const child = makeChild();
		armStdioCloseWatchdog(child as any, { graceMs: 10 });

		vi.advanceTimersByTime(1000);

		expect(child.stdout.destroy).not.toHaveBeenCalled();
	});

	it('skips streams that are already gone', () => {
		const child = makeChild();
		child.stdout.destroyed = true;
		armStdioCloseWatchdog(child as any, { graceMs: 10 });

		child.emit('exit', 1, null);
		vi.advanceTimersByTime(10);

		expect(child.stdout.destroy).not.toHaveBeenCalled();
		expect(child.stderr.destroy).toHaveBeenCalled();
	});
});
