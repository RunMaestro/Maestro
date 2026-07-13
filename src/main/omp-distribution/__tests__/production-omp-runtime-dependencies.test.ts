import { describe, expect, it } from 'vitest';

import { createProductionOmpRuntimeDependencies } from '../production-omp-runtime-dependencies';
import { createProductionOmpRuntimeResolver } from '../production-omp-runtime-resolver';
import type { ProductionOmpResource } from '../production-omp-resource';

const resource = {
	bundledRuntime: {
		bunExecutable: 'C:/Program Files/Maestro/resources/omp/bun/bun.exe',
		ompCliPath: 'C:/Program Files/Maestro/resources/omp/omp/dist/cli.js',
		bunSha512:
			'sha512-z7sYIP1ZaDJXOmMRIDmr4wg+J14iOX0Na+rif68NAYPCZ+gglOMUHF7f+qQR7f1pyS2iQpG4pmqbyw+WE4Gsag==',
		ompCliSha512:
			'sha512-z7sYIP1ZaDJXOmMRIDmr4wg+J14iOX0Na+rif68NAYPCZ+gglOMUHF7f+qQR7f1pyS2iQpG4pmqbyw+WE4Gsag==',
		bunVersion: '1.3.14' as const,
	},
} as ProductionOmpResource;

const pinnedRelease = Object.freeze({
	packageName: '@oh-my-pi/pi-coding-agent' as const,
	version: '16.4.8' as const,
	registryOrigin: 'https://registry.npmjs.org',
	npmKeyIds: Object.freeze(['SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U']),
});

describe('production OMP runtime dependencies', () => {
	it('does not read, download, or install the bundled fallback after native refusal', async () => {
		let confirmations = 0;
		const dependencies = createProductionOmpRuntimeDependencies({
			resource,
			confirmBundledRuntime: async () => {
				confirmations += 1;
				return false;
			},
		});
		const resolver = createProductionOmpRuntimeResolver({
			pinnedRelease,
			managedInstallOptIn: dependencies.managedInstallOptIn,
			...dependencies.runtimeResolverDependencies,
		});

		expect(resolver.managedInstallAllowed()).toBe(true);
		await expect(resolver.resolveManaged()).rejects.toThrow('declined');
		expect(confirmations).toBe(1);
	});
});
