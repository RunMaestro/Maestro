import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PluginRuntimeStartupDependencies } from '../plugin-runtime-startup-config';

function startupDependencies(): PluginRuntimeStartupDependencies {
	return {
		productionOmp: {
			pluginsDir: join(process.cwd(), 'omp-plugins'),
			archivePath: join(process.cwd(), 'com.maestro.omp.omp'),
			expectedArchiveSha256: 'a'.repeat(64),
			trustRoot: {
				keyId: 'maestro-omp-plugin-root-2026-07',
				algorithm: 'ed25519',
				publicKey: 'test-production-public-key',
			},
			verifySignature: () => true,
			pinnedRelease: {
				packageName: '@oh-my-pi/pi-coding-agent',
				version: '16.4.8',
				registryOrigin: 'https://registry.npmjs.org',
				npmKeyIds: ['maestro-omp-plugin-root-2026-07'],
			},
			resolver: {
				resolveSystem: async () => null,
				managedInstallAllowed: () => false,
				resolveManaged: async () => {
					throw new Error('managed install is disabled');
				},
			},
		},
	};
}

async function loadStartupConfig() {
	vi.resetModules();
	return import('../plugin-runtime-startup-config');
}

describe('plugin runtime startup configuration', () => {
	it('accepts a complete dependency identity before the first main startup read and freezes it', async () => {
		const startupConfig = await loadStartupConfig();
		const configured = startupDependencies();

		startupConfig.configurePluginRuntimeStartupDependencies(configured);
		const consumed = startupConfig.readPluginRuntimeStartupDependencies();

		expect(consumed).toBe(configured);
		expect(Object.isFrozen(consumed)).toBe(true);
		expect(Object.isFrozen(consumed.productionOmp)).toBe(true);
		expect(Object.isFrozen(consumed.productionOmp?.trustRoot)).toBe(true);
		expect(Object.isFrozen(consumed.productionOmp?.pinnedRelease)).toBe(true);
		expect(Object.isFrozen(consumed.productionOmp?.pinnedRelease.npmKeyIds)).toBe(true);
		expect(() => {
			if (!consumed.productionOmp) throw new Error('missing configured OMP dependencies');
			consumed.productionOmp.trustRoot.keyId = 'mutated';
		}).toThrow(TypeError);
		expect(consumed.productionOmp?.trustRoot.keyId).toBe('maestro-omp-plugin-root-2026-07');
	});

	it('uses the packaged production configuration when no startup override is configured', async () => {
		const startupConfig = await loadStartupConfig();
		const packagedConfiguration = startupDependencies().productionOmp;
		if (!packagedConfiguration) throw new Error('missing packaged OMP configuration');

		const consumed = startupConfig.readPluginRuntimeStartupDependencies();

		expect(
			startupConfig.resolveProductionOmpStartupConfiguration(consumed, packagedConfiguration)
		).toBe(packagedConfiguration);
		expect(() =>
			startupConfig.configurePluginRuntimeStartupDependencies(startupDependencies())
		).toThrow(/already been read/);
	});

	it('rejects duplicate startup configuration before bootstrap', async () => {
		const startupConfig = await loadStartupConfig();

		startupConfig.configurePluginRuntimeStartupDependencies(startupDependencies());

		expect(() =>
			startupConfig.configurePluginRuntimeStartupDependencies(startupDependencies())
		).toThrow(/already configured/);
	});

	it('fails closed for malformed or partial production identities', async () => {
		const startupConfig = await loadStartupConfig();
		const missingProductionConfiguration = {} as unknown as PluginRuntimeStartupDependencies;

		expect(() =>
			startupConfig.configurePluginRuntimeStartupDependencies(missingProductionConfiguration)
		).toThrow(/productionOmp/);

		const partialProductionConfiguration = {
			productionOmp: {
				pluginsDir: join(process.cwd(), 'omp-plugins'),
			},
		} as unknown as PluginRuntimeStartupDependencies;

		expect(() =>
			startupConfig.configurePluginRuntimeStartupDependencies(partialProductionConfiguration)
		).toThrow(/complete production OMP identity/);
	});
});
