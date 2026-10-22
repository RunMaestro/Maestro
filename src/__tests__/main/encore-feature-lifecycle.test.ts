/**
 * The Encore lifecycle is the one path a feature's background services follow
 * its flag on, so `maestro-cli encore disable` (a plain settings write) stops
 * exactly what the Extensions toggle stops. These tests pin the contract: only
 * flags that CHANGED act, on -> reconcile and off -> stopAll, nothing runs before
 * the hooks are attached, and one failing hook cannot strand the others.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	createEncoreFeatureLifecycle,
	type EncoreServiceHooks,
} from '../../main/encore-feature-lifecycle';

function hooks() {
	return { reconcile: vi.fn(), stopAll: vi.fn() };
}

describe('createEncoreFeatureLifecycle', () => {
	it('does nothing before the hooks are attached', () => {
		const lifecycle = createEncoreFeatureLifecycle({ onError: vi.fn() });
		// No services exist yet; a flag change has nothing to settle.
		expect(() => lifecycle.apply({ pianola: true })).not.toThrow();
	});

	it('stops a feature switched off and starts one switched on, leaving the rest alone', () => {
		const pianola = hooks();
		const cue = hooks();
		const coworking = hooks();
		const lifecycle = createEncoreFeatureLifecycle({ onError: vi.fn() });
		lifecycle.attach({ pianola, maestroCue: cue, coworking }, { pianola: true });

		// A CLI write: Cue off, coworking on, pianola unchanged.
		lifecycle.apply({ pianola: true, maestroCue: false, coworking: true });

		expect(cue.stopAll).toHaveBeenCalledOnce();
		expect(cue.reconcile).not.toHaveBeenCalled();
		expect(coworking.reconcile).toHaveBeenCalledOnce();
		expect(coworking.stopAll).not.toHaveBeenCalled();
		expect(pianola.reconcile).not.toHaveBeenCalled();
		expect(pianola.stopAll).not.toHaveBeenCalled();
	});

	it('compares against the resolved defaults, so a missing key is not a change', () => {
		const cue = hooks();
		const lifecycle = createEncoreFeatureLifecycle({ onError: vi.fn() });
		lifecycle.attach({ maestroCue: cue }, undefined);

		// Cue defaults on; writing it explicitly on is not a transition.
		lifecycle.apply({ maestroCue: true });
		expect(cue.reconcile).not.toHaveBeenCalled();
		expect(cue.stopAll).not.toHaveBeenCalled();
	});

	it('acts once per transition, not on every write', () => {
		const pianola = hooks();
		const lifecycle = createEncoreFeatureLifecycle({ onError: vi.fn() });
		lifecycle.attach({ pianola }, { pianola: true });

		lifecycle.apply({ pianola: false });
		lifecycle.apply({ pianola: false, symphony: false });
		lifecycle.apply({ pianola: true });

		expect(pianola.stopAll).toHaveBeenCalledOnce();
		expect(pianola.reconcile).toHaveBeenCalledOnce();
	});

	it('reports a failing hook and still settles the other features', () => {
		const onError = vi.fn();
		const failing = {
			reconcile: vi.fn(),
			stopAll: vi.fn(() => {
				throw new Error('boom');
			}),
		};
		const plugins = hooks();
		const services: EncoreServiceHooks = { pianola: failing, plugins };
		const lifecycle = createEncoreFeatureLifecycle({ onError });
		lifecycle.attach(services, { pianola: true, plugins: true });

		lifecycle.apply({ pianola: false, plugins: false });

		expect(onError).toHaveBeenCalledWith('pianola', 'stopAll', expect.any(Error));
		expect(plugins.stopAll).toHaveBeenCalledOnce();
	});

	it('startIfEnabled starts a feature at boot only when its flag is on', () => {
		const pianola = hooks();
		const plugins = hooks();
		const lifecycle = createEncoreFeatureLifecycle({ onError: vi.fn() });
		lifecycle.attach({ pianola, plugins }, { pianola: true });

		lifecycle.startIfEnabled('pianola', { pianola: true });
		lifecycle.startIfEnabled('plugins', { pianola: true });

		expect(pianola.reconcile).toHaveBeenCalledOnce();
		expect(plugins.reconcile).not.toHaveBeenCalled();
	});
});
