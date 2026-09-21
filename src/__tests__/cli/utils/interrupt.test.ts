import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { installInterruptHandler } from '../../../cli/utils/interrupt';

function fakeProcess() {
	const emitter = new EventEmitter();
	const exit = vi.fn();
	return { emitter, exit, target: Object.assign(emitter, { exit }) as unknown as NodeJS.Process };
}

describe('installInterruptHandler', () => {
	it('aborts the signal on the first SIGINT and tells the operator once', () => {
		const { emitter, target } = fakeProcess();
		const onFirst = vi.fn();
		const { signal } = installInterruptHandler({ onFirst, target });

		expect(signal.aborted).toBe(false);
		emitter.emit('SIGINT');

		expect(signal.aborted).toBe(true);
		expect(onFirst).toHaveBeenCalledTimes(1);
	});

	it('exits with 130 on the second SIGINT instead of waiting for a graceful stop', () => {
		const { emitter, exit, target } = fakeProcess();
		installInterruptHandler({ target });

		emitter.emit('SIGINT');
		expect(exit).not.toHaveBeenCalled();
		emitter.emit('SIGINT');

		expect(exit).toHaveBeenCalledWith(130);
	});

	it('also treats SIGTERM as a request to stop', () => {
		const { emitter, target } = fakeProcess();
		const { signal } = installInterruptHandler({ target });

		emitter.emit('SIGTERM');

		expect(signal.aborted).toBe(true);
	});

	it('stops listening once disposed, so a later run in the same process is unaffected', () => {
		const { emitter, exit, target } = fakeProcess();
		const { signal, dispose } = installInterruptHandler({ target });

		dispose();
		emitter.emit('SIGINT');
		emitter.emit('SIGINT');

		expect(signal.aborted).toBe(false);
		expect(exit).not.toHaveBeenCalled();
		expect(emitter.listenerCount('SIGINT')).toBe(0);
		expect(emitter.listenerCount('SIGTERM')).toBe(0);
	});
});
