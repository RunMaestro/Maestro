/**
 * @file stop-signals.test.ts
 * @description Tests for src/maestro-p/stop-signals.ts.
 *
 * With no handler, SIGINT and SIGTERM ended maestro-p on the spot: no result
 * envelope, no `/quit` to the TUI. The first signal must now settle the turn
 * gracefully and a second one must hard-stop, and neither may exit with 2,
 * which makes the desktop replay the prompt through the API.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';

import {
	installStopSignalHandlers,
	STOP_EXIT_CODES,
	STOP_SIGNALS,
} from '../../maestro-p/stop-signals';

function setup() {
	const target = new EventEmitter();
	const onStop = vi.fn();
	const onForce = vi.fn();
	const uninstall = installStopSignalHandlers({ onStop, onForce }, target);
	return { target, onStop, onForce, uninstall };
}

describe('installStopSignalHandlers', () => {
	it.each(STOP_SIGNALS)('treats a first %s as a graceful stop', (signal) => {
		const { target, onStop, onForce } = setup();
		target.emit(signal, signal);
		expect(onStop).toHaveBeenCalledTimes(1);
		expect(onStop).toHaveBeenCalledWith(signal);
		expect(onForce).not.toHaveBeenCalled();
	});

	it('hard-stops on a second signal while the first is still settling', () => {
		const { target, onStop, onForce } = setup();
		target.emit('SIGINT', 'SIGINT');
		target.emit('SIGINT', 'SIGINT');
		expect(onStop).toHaveBeenCalledTimes(1);
		expect(onForce).toHaveBeenCalledTimes(1);
		expect(onForce).toHaveBeenCalledWith('SIGINT');
	});

	it('counts a SIGTERM after a SIGINT as the second signal', () => {
		const { target, onStop, onForce } = setup();
		target.emit('SIGINT', 'SIGINT');
		target.emit('SIGTERM', 'SIGTERM');
		expect(onStop).toHaveBeenCalledWith('SIGINT');
		expect(onForce).toHaveBeenCalledWith('SIGTERM');
	});

	it('removes both listeners when uninstalled', () => {
		const { target, onStop, uninstall } = setup();
		uninstall();
		expect(target.listenerCount('SIGINT')).toBe(0);
		expect(target.listenerCount('SIGTERM')).toBe(0);
		target.emit('SIGINT', 'SIGINT');
		expect(onStop).not.toHaveBeenCalled();
	});
});

describe('STOP_EXIT_CODES', () => {
	it('uses the 128 + signal convention', () => {
		expect(STOP_EXIT_CODES.SIGINT).toBe(130);
		expect(STOP_EXIT_CODES.SIGTERM).toBe(143);
	});

	it("stays clear of maestro-p's own exit codes, including the limit replay code 2", () => {
		for (const code of Object.values(STOP_EXIT_CODES)) {
			expect(code).toBeGreaterThan(6);
		}
	});
});
