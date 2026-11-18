/**
 * The macOS sleep guard of `maestro-cli host`: a `caffeinate -i -w <pid>` child held while work is
 * in flight, killed when idle, and nothing at all on another platform or under
 * `--no-prevent-sleep`. `spawn` and the platform check are mocked, so no caffeinate runs.
 */
import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, isMacOSMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
	isMacOSMock: vi.fn(() => true),
}));

vi.mock('child_process', async (importOriginal) => ({
	...(await importOriginal<typeof import('child_process')>()),
	spawn: spawnMock,
}));
vi.mock('../../../shared/platformDetection', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../shared/platformDetection')>()),
	isMacOS: isMacOSMock,
}));

import { createHostSleepGuard } from '../../../cli/services/host-sleep-guard';

class FakeChild extends EventEmitter {
	pid = 4242;
	kill = vi.fn(() => {
		this.emit('exit', null, 'SIGTERM');
		return true;
	});
	unref = vi.fn();
}

describe('createHostSleepGuard', () => {
	let lines: string[];
	let children: FakeChild[];

	beforeEach(() => {
		lines = [];
		children = [];
		spawnMock.mockReset();
		spawnMock.mockImplementation(() => {
			const child = new FakeChild();
			children.push(child);
			return child;
		});
		isMacOSMock.mockReturnValue(true);
	});

	const guard = (enabled = true) =>
		createHostSleepGuard({ enabled, pid: 812, log: (line) => lines.push(line) });

	it('holds caffeinate on the host pid while there is work, once, and releases it when idle', () => {
		const sleep = guard();
		expect(sleep.holding()).toBe(false);

		sleep.update(true);
		sleep.update(true);
		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(spawnMock).toHaveBeenCalledWith('caffeinate', ['-i', '-w', '812'], { stdio: 'ignore' });
		expect(children[0].unref).toHaveBeenCalled();
		expect(sleep.holding()).toBe(true);
		expect(lines.join('\n')).toContain('Preventing sleep');

		sleep.update(false);
		expect(children[0].kill).toHaveBeenCalledTimes(1);
		expect(sleep.holding()).toBe(false);
		expect(lines.join('\n')).toContain('Allowing sleep');

		// Work again: a new hold.
		sleep.update(true);
		expect(spawnMock).toHaveBeenCalledTimes(2);
	});

	it('does nothing off macOS', () => {
		isMacOSMock.mockReturnValue(false);
		const sleep = guard();
		sleep.update(true);
		expect(spawnMock).not.toHaveBeenCalled();
		expect(sleep.holding()).toBe(false);
	});

	it('does nothing under --no-prevent-sleep', () => {
		const sleep = guard(false);
		sleep.update(true);
		expect(spawnMock).not.toHaveBeenCalled();
		expect(sleep.holding()).toBe(false);
	});

	it('holds again after caffeinate was killed from outside', () => {
		const sleep = guard();
		sleep.update(true);
		children[0].emit('exit', null, 'SIGKILL');
		expect(sleep.holding()).toBe(false);
		sleep.update(true);
		expect(spawnMock).toHaveBeenCalledTimes(2);
	});

	it('says once that caffeinate failed, and stops trying', () => {
		const sleep = guard();
		sleep.update(true);
		children[0].emit('error', new Error('spawn caffeinate ENOENT'));
		expect(sleep.holding()).toBe(false);
		sleep.update(false);
		sleep.update(true);
		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(lines.filter((line) => line.includes('Could not prevent sleep'))).toHaveLength(1);
	});

	it('says once that caffeinate could not be spawned at all, and stops trying', () => {
		spawnMock.mockImplementation(() => {
			throw new Error('EPERM');
		});
		const sleep = guard();
		sleep.update(true);
		sleep.update(true);
		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(sleep.holding()).toBe(false);
		expect(lines.filter((line) => line.includes('caffeinate did not start: EPERM'))).toHaveLength(
			1
		);
	});

	it('says nothing when idle without a hold, or when stopped without one', () => {
		const sleep = guard();
		sleep.update(false);
		sleep.stop();
		expect(spawnMock).not.toHaveBeenCalled();
		expect(lines).toEqual([]);
	});

	it('never spawns off macOS even when stopped and updated again', () => {
		isMacOSMock.mockReturnValue(false);
		const sleep = guard();
		sleep.update(true);
		sleep.stop();
		sleep.update(true);
		expect(spawnMock).not.toHaveBeenCalled();
		expect(lines).toEqual([]);
	});

	it('releases on stop and never holds after', () => {
		const sleep = guard();
		sleep.update(true);
		sleep.stop();
		expect(children[0].kill).toHaveBeenCalled();
		sleep.update(true);
		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(sleep.holding()).toBe(false);
	});
});
