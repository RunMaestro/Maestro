import { describe, it, expect, vi } from 'vitest';
import {
	createCueDispatchService,
	type CueDispatchServiceDeps,
} from '../../../main/cue/cue-dispatch-service';
import { createCueEvent } from '../../../main/cue/cue-types';
import type { CueSubscription } from '../../../shared/cue';

function makeDeps(
	sessionsByName: Array<{ id: string; name: string }> = [
		{ id: 's-1', name: 'alpha' },
		{ id: 's-2', name: 'bravo' },
	]
): {
	deps: CueDispatchServiceDeps;
	executeRun: ReturnType<typeof vi.fn>;
	logs: Array<[string, string]>;
} {
	const logs: Array<[string, string]> = [];
	const executeRun = vi.fn();
	const deps: CueDispatchServiceDeps = {
		getSessions: () => sessionsByName,
		executeRun: executeRun as CueDispatchServiceDeps['executeRun'],
		onLog: (level, message) => {
			logs.push([level, message]);
		},
	};
	return { deps, executeRun, logs };
}

function makeSub(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'my-sub',
		event: 'time.heartbeat',
		enabled: true,
		prompt: 'default prompt',
		...overrides,
	};
}

describe('createCueDispatchService', () => {
	describe('single-target', () => {
		it('returns 1 and dispatches when sub has a prompt', () => {
			const { deps, executeRun } = makeDeps();
			const svc = createCueDispatchService(deps);
			const sub = makeSub({ prompt: 'hello' });
			const event = createCueEvent('time.heartbeat', 'my-sub');

			const dispatched = svc.dispatchSubscription('owner', sub, event, 'src');

			expect(dispatched).toBe(1);
			expect(executeRun).toHaveBeenCalledTimes(1);
		});

		it('returns 0 and warns when prompt is empty', () => {
			const { deps, executeRun, logs } = makeDeps();
			const svc = createCueDispatchService(deps);
			const sub = makeSub({ prompt: '' });
			const event = createCueEvent('time.heartbeat', 'my-sub');

			const dispatched = svc.dispatchSubscription('owner', sub, event, 'src');

			expect(dispatched).toBe(0);
			expect(executeRun).not.toHaveBeenCalled();
			expect(logs.some(([level, msg]) => level === 'warn' && /no prompt/.test(msg))).toBe(true);
		});

		it('uses promptOverride when provided', () => {
			const { deps, executeRun } = makeDeps();
			const svc = createCueDispatchService(deps);
			const sub = makeSub({ prompt: '' });
			const event = createCueEvent('time.heartbeat', 'my-sub');

			const dispatched = svc.dispatchSubscription('owner', sub, event, 'src', 0, 'override!');

			expect(dispatched).toBe(1);
			expect(executeRun).toHaveBeenCalledWith(
				'owner',
				'override!',
				expect.anything(),
				'my-sub',
				undefined, // pipelineName
				undefined,
				0,
				undefined,
				undefined,
				undefined
			);
		});
	});

	describe('fan-out', () => {
		it('returns 2 when both targets have prompts', () => {
			const { deps, executeRun } = makeDeps();
			const svc = createCueDispatchService(deps);
			const sub = makeSub({
				fan_out: ['alpha', 'bravo'],
				fan_out_prompts: ['for alpha', 'for bravo'],
				prompt: 'fallback',
			});
			const event = createCueEvent('time.heartbeat', 'my-sub');

			const dispatched = svc.dispatchSubscription('owner', sub, event, 'src');

			expect(dispatched).toBe(2);
			expect(executeRun).toHaveBeenCalledTimes(2);
			expect(executeRun.mock.calls[0][1]).toBe('for alpha');
			expect(executeRun.mock.calls[1][1]).toBe('for bravo');
		});

		it('returns 1 and warns when only one fan-out target has a prompt', () => {
			const { deps, executeRun, logs } = makeDeps();
			const svc = createCueDispatchService(deps);
			const sub = makeSub({
				fan_out: ['alpha', 'bravo'],
				fan_out_prompts: ['for alpha', ''],
				prompt: '',
			});
			const event = createCueEvent('time.heartbeat', 'my-sub');

			const dispatched = svc.dispatchSubscription('owner', sub, event, 'src');

			expect(dispatched).toBe(1);
			expect(executeRun).toHaveBeenCalledTimes(1);
			expect(logs.some(([level, msg]) => level === 'warn' && /has no prompt/.test(msg))).toBe(true);
		});

		it('returns 0 and emits an error log when every fan-out target is skipped', () => {
			// This is the "manual trigger with 2 agents does nothing" scenario
			// the user reported: both agents had empty prompts due to the earlier
			// debounce race, so fan-out skipped both without any user-visible feedback.
			// Now the dispatcher emits an error log naming every skipped target.
			const { deps, executeRun, logs } = makeDeps();
			const svc = createCueDispatchService(deps);
			const sub = makeSub({
				fan_out: ['alpha', 'bravo'],
				fan_out_prompts: ['', ''],
				prompt: '',
			});
			const event = createCueEvent('time.heartbeat', 'my-sub');

			const dispatched = svc.dispatchSubscription('owner', sub, event, 'src');

			expect(dispatched).toBe(0);
			expect(executeRun).not.toHaveBeenCalled();
			const errorLog = logs.find(([level]) => level === 'error');
			expect(errorLog).toBeDefined();
			expect(errorLog![1]).toMatch(/no fan-out targets ran/);
			expect(errorLog![1]).toMatch(/alpha \(empty prompt\)/);
			expect(errorLog![1]).toMatch(/bravo \(empty prompt\)/);
		});

		it('tracks not-found targets alongside empty-prompt targets', () => {
			const { deps, logs } = makeDeps([{ id: 's-1', name: 'alpha' }]);
			const svc = createCueDispatchService(deps);
			const sub = makeSub({
				fan_out: ['alpha', 'ghost'],
				fan_out_prompts: ['', ''],
				prompt: '',
			});
			const event = createCueEvent('time.heartbeat', 'my-sub');

			const dispatched = svc.dispatchSubscription('owner', sub, event, 'src');

			expect(dispatched).toBe(0);
			const errorLog = logs.find(([level]) => level === 'error');
			expect(errorLog![1]).toMatch(/alpha \(empty prompt\)/);
			expect(errorLog![1]).toMatch(/ghost \(not found\)/);
		});

		// `fan_out` carries the display name at save time; renaming an agent
		// would otherwise silently drop it from dispatch (the YAML name no
		// longer matches any live session). `fan_out_ids` is the stable-id
		// mirror — the dispatcher must prefer it over the stale name.
		it('resolves fan-out target by fan_out_ids when the agent has been renamed', () => {
			const { deps, executeRun } = makeDeps([
				// Renamed: id is still 's-1', name is now 'alpha-renamed'.
				{ id: 's-1', name: 'alpha-renamed' },
			]);
			const svc = createCueDispatchService(deps);
			const sub = makeSub({
				fan_out: ['alpha'], // stale display name from YAML
				fan_out_ids: ['s-1'], // stable id
				prompt: 'hello',
			});
			const event = createCueEvent('time.heartbeat', 'my-sub');

			const dispatched = svc.dispatchSubscription('owner', sub, event, 'src');

			expect(dispatched).toBe(1);
			expect(executeRun).toHaveBeenCalledWith(
				's-1',
				'hello',
				expect.anything(),
				'my-sub',
				undefined, // pipelineName
				undefined,
				undefined,
				undefined,
				undefined,
				undefined
			);
		});

		it('falls back to name match when fan_out_ids is absent (legacy YAML)', () => {
			const { deps, executeRun } = makeDeps([{ id: 's-1', name: 'alpha' }]);
			const svc = createCueDispatchService(deps);
			const sub = makeSub({
				fan_out: ['alpha'],
				prompt: 'hello',
			});
			const event = createCueEvent('time.heartbeat', 'my-sub');

			const dispatched = svc.dispatchSubscription('owner', sub, event, 'src');

			expect(dispatched).toBe(1);
			expect(executeRun).toHaveBeenCalledWith(
				's-1',
				'hello',
				expect.anything(),
				'my-sub',
				undefined, // pipelineName
				undefined,
				undefined,
				undefined,
				undefined,
				undefined
			);
		});
	});
});
