import { describe, expect, it } from 'vitest';
import type { AgentError } from '../../../types';
import { createRunController } from '../run-control';
import type { AutoRunPause } from '../engine-types';

const agentError = (type: AgentError['type'] = 'network_error'): AgentError => ({
	type,
	message: 'boom',
	recoverable: true,
	agentId: 'claude-code',
	timestamp: 0,
});

const errorPause = (type?: AgentError['type']): AutoRunPause => ({
	kind: 'error',
	document: 'tasks',
	agentError: agentError(type),
});

const gatePause: AutoRunPause = {
	kind: 'gate',
	document: 'tasks',
	gate: { reason: 'Add the key', line: 3 },
};

/** A clock and timer the test drives by hand. */
function manual() {
	let now = 1_000;
	const timers: Array<{ id: number; ms: number; fn: () => void; live: boolean }> = [];
	return {
		clock: { now: () => now },
		advance: (ms: number) => {
			now += ms;
		},
		setTimer: (fn: () => void, ms: number) => {
			const timer = { id: timers.length, ms, fn, live: true };
			timers.push(timer);
			return timer.id;
		},
		clearTimer: (id: unknown) => {
			timers[id as number].live = false;
		},
		timers,
		fire: (index = 0) => {
			if (timers[index].live) timers[index].fn();
		},
	};
}

describe('createRunController', () => {
	it('answers a pause with the person resolution and reports it was not automatic', async () => {
		const m = manual();
		const controller = createRunController({ clock: m.clock });

		const waiting = controller.awaitResolution(errorPause());
		expect(controller.isPaused()).toBe(true);
		expect(controller.pending()).toMatchObject({ kind: 'error' });
		expect(controller.resolve('skip')).toBe(true);

		await expect(waiting).resolves.toEqual({ resolution: 'skip', auto: false });
		expect(controller.isPaused()).toBe(false);
	});

	it('ignores a resolve with nothing pending', () => {
		const controller = createRunController({ clock: manual().clock });

		expect(controller.resolve('resume')).toBe(false);
	});

	it('answers abort on a stop while paused, and for any pause that follows', async () => {
		const controller = createRunController({ clock: manual().clock });

		const waiting = controller.awaitResolution(gatePause);
		controller.requestStop();

		await expect(waiting).resolves.toEqual({ resolution: 'abort', auto: false });
		expect(controller.stopRequested()).toBe(true);
		await expect(controller.awaitResolution(errorPause())).resolves.toEqual({
			resolution: 'abort',
			auto: false,
		});
	});

	it('leaves paused time off the clock, open span included', async () => {
		const m = manual();
		const controller = createRunController({ clock: m.clock });

		expect(controller.pausedMs()).toBe(0);
		const waiting = controller.awaitResolution(errorPause());
		m.advance(4_000);
		expect(controller.pausedMs()).toBe(4_000);
		controller.resolve('resume');
		await waiting;
		m.advance(10_000);
		expect(controller.pausedMs()).toBe(4_000);

		const second = controller.awaitResolution(gatePause);
		m.advance(500);
		controller.resolve('resume');
		await second;
		expect(controller.pausedMs()).toBe(4_500);
	});

	describe('auto-resume', () => {
		const policy = { delayMs: 300_000, maxAttempts: 2 };

		it('resumes an error pause when the timer fires', async () => {
			const m = manual();
			const controller = createRunController({ autoResume: policy, ...m });

			const waiting = controller.awaitResolution(errorPause());
			expect(m.timers[0].ms).toBe(300_000);
			m.advance(300_000);
			m.fire();

			await expect(waiting).resolves.toEqual({ resolution: 'resume', auto: true });
			expect(controller.autoResumesUsed()).toBe(1);
			expect(controller.pausedMs()).toBe(300_000);
		});

		it('is cancelled by a person answering first', async () => {
			const m = manual();
			const controller = createRunController({ autoResume: policy, ...m });

			const waiting = controller.awaitResolution(errorPause());
			controller.resolve('abort');
			m.fire();

			await expect(waiting).resolves.toEqual({ resolution: 'abort', auto: false });
			expect(m.timers[0].live).toBe(false);
			expect(controller.autoResumesUsed()).toBe(0);
		});

		it('gives up after the attempts run out and waits for a person', async () => {
			const m = manual();
			const controller = createRunController({ autoResume: policy, ...m });

			for (let attempt = 0; attempt < 2; attempt++) {
				const waiting = controller.awaitResolution(errorPause());
				m.fire(attempt);
				await expect(waiting).resolves.toMatchObject({ auto: true });
			}
			const third = controller.awaitResolution(errorPause());

			expect(m.timers).toHaveLength(2);
			expect(controller.isPaused()).toBe(true);
			controller.resolve('resume');
			await expect(third).resolves.toMatchObject({ auto: false });
		});

		it('never schedules for a gate', () => {
			const m = manual();
			const controller = createRunController({ autoResume: policy, ...m });

			void controller.awaitResolution(gatePause);

			expect(m.timers).toHaveLength(0);
		});

		it('never schedules for a limit error', () => {
			const m = manual();
			const controller = createRunController({ autoResume: policy, ...m });

			void controller.awaitResolution(errorPause('rate_limited'));
			void controller.resolve('abort');
			void controller.awaitResolution(errorPause('token_exhaustion'));

			expect(m.timers).toHaveLength(0);
		});

		it('does not schedule when the policy is off', () => {
			const m = manual();
			const controller = createRunController({ autoResume: null, ...m });

			void controller.awaitResolution(errorPause());

			expect(m.timers).toHaveLength(0);
		});
	});
});
