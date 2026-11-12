/**
 * @file plugin-background-supervisor.test.ts
 * @description Crash-restart discipline for plugin background services: a
 * registered service's sandbox crash schedules a bounded-backoff restart that
 * re-runs the plugin (whose activate path re-registers); consecutive rapid
 * failures escalate the backoff exponentially and cap at failed-permanent; an
 * intentional stop (disable/reload) or uninstall teardown clears registrations
 * and never restarts; health reports state/restarts/services truthfully.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	PluginBackgroundSupervisor,
	type PluginBackgroundSupervisorDeps,
} from '../../../main/plugins/plugin-background-supervisor';

// Mirror the (unexported) source constants so timing assertions stay in sync.
const MAX_RESTARTS = 5;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
const STABLE_RUN_MS = 60_000;

let restartPlugin: ReturnType<typeof vi.fn>;
let enabled: Set<string>;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	restartPlugin = vi.fn();
	enabled = new Set(['p']);
});

afterEach(() => {
	vi.useRealTimers();
});

function makeSupervisor(over: Partial<PluginBackgroundSupervisorDeps> = {}) {
	return new PluginBackgroundSupervisor({
		restartPlugin,
		isPluginEnabled: (id) => enabled.has(id),
		...over,
	});
}

describe('register / unregister', () => {
	it('registers with a caller id, generates one when absent, and reports running', () => {
		const sup = makeSupervisor();
		expect(sup.register('p', { id: 'svc' })).toEqual({ serviceId: 'svc' });
		const generated = sup.register('p', {});
		expect(generated.serviceId).toMatch(/^bg_/);

		const health = sup.health('p');
		expect(health.state).toBe('running');
		expect(health.restarts).toBe(0);
		expect(health.services.map((s) => s.id)).toContain('svc');
		expect(health.services).toHaveLength(2);
	});

	it('caps services per plugin but allows idempotent re-registration at the cap', () => {
		const sup = makeSupervisor();
		for (let i = 0; i < 16; i++) sup.register('p', { id: `svc${i}` });
		expect(() => sup.register('p', { id: 'one-too-many' })).toThrow(/limit reached/);
		// Same id again is a re-registration, not growth.
		expect(sup.register('p', { id: 'svc0' })).toEqual({ serviceId: 'svc0' });
		expect(sup.health('p').services).toHaveLength(16);
	});

	it('unregister removes one service; unknown ids report false; last one leaves supervision', () => {
		const sup = makeSupervisor();
		sup.register('p', { id: 'a' });
		sup.register('p', { id: 'b' });
		expect(sup.unregister('p', 'nope')).toBe(false);
		expect(sup.unregister('p', 'a')).toBe(true);
		expect(sup.unregister('p', 'a')).toBe(false);
		expect(sup.unregister('p', 'b')).toBe(true);

		// Fully unregistered: a later crash restarts nothing.
		sup.onPluginCrash('p', 1);
		vi.advanceTimersByTime(BACKOFF_CAP_MS * 2);
		expect(restartPlugin).not.toHaveBeenCalled();
		expect(sup.healthAll()).toEqual([]);
	});

	it('bounds a hostile service name and ignores non-string ids', () => {
		const sup = makeSupervisor();
		const { serviceId } = sup.register('p', { id: 42 as unknown, name: 'x'.repeat(500) });
		expect(serviceId).toMatch(/^bg_/);
		expect(sup.health('p').services[0].name).toHaveLength(200);
	});
});

describe('crash -> bounded-backoff restart', () => {
	it('restarts the owning plugin after the first backoff; re-registration restores running', () => {
		const sup = makeSupervisor();
		sup.register('p', { id: 'svc' });

		sup.onPluginCrash('p', 1);
		const afterCrash = sup.health('p');
		expect(afterCrash.state).toBe('restarting');
		expect(afterCrash.restarts).toBe(1);
		// Registrations died with the child.
		expect(afterCrash.services).toEqual([]);
		expect(afterCrash.lastError).toMatch(/code 1/);

		// Not yet: backoff base is 1s.
		vi.advanceTimersByTime(BACKOFF_BASE_MS - 1);
		expect(restartPlugin).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(restartPlugin).toHaveBeenCalledTimes(1);
		expect(restartPlugin).toHaveBeenCalledWith('p');

		// The restarted child's activate path re-registers -> running again.
		sup.register('p', { id: 'svc' });
		const recovered = sup.health('p');
		expect(recovered.state).toBe('running');
		expect(recovered.services.map((s) => s.id)).toEqual(['svc']);
		expect(recovered.lastError).toBeUndefined();
	});

	it('doubles the backoff per consecutive failure and caps the delay', () => {
		const sup = makeSupervisor();
		sup.register('p', { id: 'svc' });

		// Failure 1 -> 1s, failure 2 -> 2s, failure 3 -> 4s.
		for (const delay of [1000, 2000, 4000]) {
			sup.onPluginCrash('p', 1);
			vi.advanceTimersByTime(delay - 1);
			const before = restartPlugin.mock.calls.length;
			vi.advanceTimersByTime(1);
			expect(restartPlugin.mock.calls.length).toBe(before + 1);
		}
		// Failures 4 and 5 -> 8s, 16s; a 6th would exceed MAX_RESTARTS.
		sup.onPluginCrash('p', 1);
		vi.advanceTimersByTime(8000);
		sup.onPluginCrash('p', 1);
		vi.advanceTimersByTime(16_000);
		expect(restartPlugin).toHaveBeenCalledTimes(MAX_RESTARTS);
	});

	it('a crash while restarting (child died before re-registering) burns another attempt', () => {
		const sup = makeSupervisor();
		sup.register('p', { id: 'svc' });
		sup.onPluginCrash('p', 1);
		vi.advanceTimersByTime(BACKOFF_BASE_MS);
		expect(restartPlugin).toHaveBeenCalledTimes(1);

		// Restarted child crashes again WITHOUT registering.
		sup.onPluginCrash('p', 9);
		expect(sup.health('p').restarts).toBe(2);
		vi.advanceTimersByTime(2000);
		expect(restartPlugin).toHaveBeenCalledTimes(2);
	});

	it('marks failed-permanent after MAX_RESTARTS consecutive failures and stops retrying', () => {
		const sup = makeSupervisor();
		sup.register('p', { id: 'svc' });

		for (let i = 0; i < MAX_RESTARTS; i++) {
			sup.onPluginCrash('p', 1);
			vi.advanceTimersByTime(BACKOFF_CAP_MS);
		}
		expect(restartPlugin).toHaveBeenCalledTimes(MAX_RESTARTS);

		sup.onPluginCrash('p', 1);
		expect(sup.health('p').state).toBe('failed-permanent');
		vi.advanceTimersByTime(BACKOFF_CAP_MS * 4);
		expect(restartPlugin).toHaveBeenCalledTimes(MAX_RESTARTS);

		// failed-permanent is terminal for crashes: further crash events are ignored.
		sup.onPluginCrash('p', 1);
		expect(sup.health('p').state).toBe('failed-permanent');
	});

	it('a stable run resets the failure streak', () => {
		const sup = makeSupervisor();
		sup.register('p', { id: 'svc' });
		sup.onPluginCrash('p', 1);
		vi.advanceTimersByTime(BACKOFF_BASE_MS);
		sup.register('p', { id: 'svc' });
		expect(sup.health('p').restarts).toBe(1);

		// Runs stably past the threshold, then dies: streak resets, then +1.
		vi.advanceTimersByTime(STABLE_RUN_MS);
		sup.onPluginCrash('p', 1);
		expect(sup.health('p').restarts).toBe(1);
	});

	it('never restarts a plugin disabled mid-backoff', () => {
		const sup = makeSupervisor();
		sup.register('p', { id: 'svc' });
		sup.onPluginCrash('p', 1);
		enabled.delete('p');
		vi.advanceTimersByTime(BACKOFF_CAP_MS);
		expect(restartPlugin).not.toHaveBeenCalled();
		expect(sup.health('p').state).toBe('stopped');
	});

	it('a crash with no registered services restarts nothing', () => {
		const sup = makeSupervisor();
		sup.onPluginCrash('ghost', 1);
		vi.advanceTimersByTime(BACKOFF_CAP_MS);
		expect(restartPlugin).not.toHaveBeenCalled();
		expect(sup.healthAll()).toEqual([]);
	});

	it('a throwing restart hook schedules the next attempt instead of losing the plugin', () => {
		restartPlugin.mockImplementationOnce(() => {
			throw new Error('refresh failed');
		});
		const sup = makeSupervisor();
		sup.register('p', { id: 'svc' });
		sup.onPluginCrash('p', 1);
		vi.advanceTimersByTime(BACKOFF_BASE_MS);
		expect(sup.health('p').state).toBe('restarting');
		expect(sup.health('p').lastError).toMatch(/refresh failed/);
		vi.advanceTimersByTime(2000);
		expect(restartPlugin).toHaveBeenCalledTimes(2);
	});
});

describe('intentional stop / teardown', () => {
	it('onPluginStopped (disable/reload) clears services and the exit is never a crash', () => {
		const sup = makeSupervisor();
		sup.register('p', { id: 'svc' });
		sup.onPluginStopped('p');

		const health = sup.health('p');
		expect(health.state).toBe('stopped');
		expect(health.services).toEqual([]);
		expect(health.restarts).toBe(0);

		// The stopped child's exit event (possibly non-zero on hard-kill) arrives
		// after the stop: it must NOT schedule a restart.
		sup.onPluginCrash('p', 1);
		vi.advanceTimersByTime(BACKOFF_CAP_MS * 2);
		expect(restartPlugin).not.toHaveBeenCalled();
		expect(sup.health('p').state).toBe('stopped');
	});

	it('onPluginStopped cancels a pending backoff restart', () => {
		const sup = makeSupervisor();
		sup.register('p', { id: 'svc' });
		sup.onPluginCrash('p', 1);
		expect(sup.health('p').state).toBe('restarting');

		sup.onPluginStopped('p');
		vi.advanceTimersByTime(BACKOFF_CAP_MS * 2);
		expect(restartPlugin).not.toHaveBeenCalled();
		expect(sup.health('p').state).toBe('stopped');
	});

	it('teardown (uninstall) forgets the plugin entirely, mid-backoff included', () => {
		const sup = makeSupervisor();
		sup.register('p', { id: 'svc' });
		sup.onPluginCrash('p', 1);
		sup.teardown('p');

		vi.advanceTimersByTime(BACKOFF_CAP_MS * 2);
		expect(restartPlugin).not.toHaveBeenCalled();
		expect(sup.healthAll()).toEqual([]);
		// Fresh default for an unknown plugin.
		expect(sup.health('p')).toEqual({ pluginId: 'p', state: 'stopped', restarts: 0, services: [] });
	});

	it('stopAll (app quit) cancels every pending restart across plugins', () => {
		const sup = makeSupervisor();
		enabled.add('q');
		sup.register('p', { id: 'a' });
		sup.register('q', { id: 'b' });
		sup.onPluginCrash('p', 1);
		sup.onPluginCrash('q', 1);

		sup.stopAll();
		vi.advanceTimersByTime(BACKOFF_CAP_MS * 2);
		expect(restartPlugin).not.toHaveBeenCalled();
		expect(sup.healthAll()).toEqual([]);
	});
});

describe('health reporting', () => {
	it('returns fresh serializable objects, never internal references', () => {
		const sup = makeSupervisor();
		sup.register('p', { id: 'svc', name: 'poller' });
		const a = sup.health('p');
		a.services[0].name = 'mutated';
		expect(sup.health('p').services[0].name).toBe('poller');
	});

	it('healthAll includes restarting and failed plugins', () => {
		const sup = makeSupervisor();
		enabled.add('q');
		sup.register('p', { id: 'a' });
		sup.register('q', { id: 'b' });
		sup.onPluginCrash('p', 1);

		const all = sup.healthAll();
		expect(all).toHaveLength(2);
		const states = new Map(all.map((h) => [h.pluginId, h.state]));
		expect(states.get('p')).toBe('restarting');
		expect(states.get('q')).toBe('running');
	});
});
