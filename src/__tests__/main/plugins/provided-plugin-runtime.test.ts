import { describe, expect, it, vi } from 'vitest';

import { enableProvidedPluginRuntimeForConsent } from '../../../main/plugins/provided-plugin-runtime';

function setup(record: { id: string; installOwner?: 'bundle' | 'external' } | undefined) {
	const features: Record<string, boolean> = { plugins: false };
	const settingsStore = {
		get: vi.fn(() => ({ ...features })),
		set: vi.fn((_key: string, value: Record<string, boolean>) => Object.assign(features, value)),
	};
	const manager = {
		getRegistry: vi.fn(() => ({ records: record ? [record] : [] })),
		refresh: vi.fn(),
	};
	return { features, settingsStore, manager };
}

describe('enableProvidedPluginRuntimeForConsent', () => {
	it('atomically opens the runtime gate only for verified bundled OMP before consent', () => {
		const { features, settingsStore, manager } = setup({
			id: 'com.maestro.omp',
			installOwner: 'bundle',
		});

		expect(
			enableProvidedPluginRuntimeForConsent('com.maestro.omp', { settingsStore, manager })
		).toBe(true);
		expect(features.plugins).toBe(true);
		expect(settingsStore.set).toHaveBeenCalledWith('encoreFeatures', { plugins: true });
		expect(manager.refresh).toHaveBeenCalledTimes(1);
	});

	it('fails closed for a spoofed reserved id and never mutates the community runtime gate', () => {
		const { features, settingsStore, manager } = setup({ id: 'com.maestro.omp' });

		expect(
			enableProvidedPluginRuntimeForConsent('com.maestro.omp', { settingsStore, manager })
		).toBe(false);
		expect(features.plugins).toBe(false);
		expect(settingsStore.set).not.toHaveBeenCalled();
		expect(manager.refresh).not.toHaveBeenCalled();
	});
});
