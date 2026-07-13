import * as os from 'os';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

import { PluginManager } from '../../../main/plugins/plugin-manager';

const request = {
	archivePath: '/verified/com.maestro.omp.omp-plugin.json',
	expectedSha256: 'a'.repeat(64),
	owner: 'external' as const,
};

describe('PluginManager.installOrUpdateArchive', () => {
	it('routes OMP archive installation through the single immutable-trust operation', () => {
		const installOrUpdateArchive = vi.fn(() => ({
			action: 'installed' as const,
			manifest: {
				id: 'com.maestro.omp',
				name: 'OMP',
				version: '1.0.0',
				tier: 1 as const,
				entry: 'index.js',
				maestro: { minHostApi: '1.0.0' },
			},
			artifactSha256: 'a'.repeat(64),
		}));
		const manager = new PluginManager({
			isEnabled: () => true,
			ompArchiveInstaller: { installOrUpdateArchive },
		});

		const result = manager.installOrUpdateArchive(request);

		expect(result.success).toBe(true);
		expect(installOrUpdateArchive).toHaveBeenCalledWith(request);
	});

	it('does not let the legacy path install an OMP artifact without published digest verification', () => {
		const manager = new PluginManager({ isEnabled: () => true });

		expect(manager.install('/unverified/com.maestro.omp.omp-plugin.json')).toEqual({
			success: false,
			error: 'OMP archives require installOrUpdateArchive with immutable trust verification',
		});
	});
});
