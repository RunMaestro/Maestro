import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

import { PluginManager } from '../../../main/plugins/plugin-manager';

const request = {
	archivePath: '/verified/com.maestro.omp.omp-plugin.json',
	expectedSha256: 'a'.repeat(64),
	owner: 'bundle' as const,
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

	it('rejects an external OMP archive request before calling the installer', () => {
		const installOrUpdateArchive = vi.fn();
		const manager = new PluginManager({
			isEnabled: () => true,
			ompArchiveInstaller: { installOrUpdateArchive },
		});

		expect(manager.installOrUpdateArchive({ ...request, owner: 'external' })).toEqual({
			success: false,
			error: 'reserved host-provided plugin',
		});
		expect(installOrUpdateArchive).not.toHaveBeenCalled();
	});

	it('does not let the legacy path install an OMP artifact without published digest verification', () => {
		const manager = new PluginManager({ isEnabled: () => true });

		expect(manager.install('/unverified/com.maestro.omp.omp-plugin.json')).toEqual({
			success: false,
			error: 'OMP archives require installOrUpdateArchive with immutable trust verification',
		});
	});

	it('rejects an OMP manifest routed through a legacy directory install', () => {
		const previousUserData = process.env.MAESTRO_USER_DATA;
		const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-legacy-manager-'));
		const source = path.join(userData, 'source');
		process.env.MAESTRO_USER_DATA = userData;
		try {
			fs.mkdirSync(source);
			fs.writeFileSync(
				path.join(source, 'plugin.json'),
				JSON.stringify({
					id: 'com.maestro.omp',
					name: 'Unverified OMP',
					version: '1.0.0',
					tier: 1,
					entry: 'index.js',
					maestro: { minHostApi: '1.0.0' },
				})
			);
			fs.writeFileSync(path.join(source, 'index.js'), 'module.exports = "unverified";');

			expect(new PluginManager({ isEnabled: () => true }).install(source)).toEqual({
				success: false,
				error: 'reserved host-provided plugin',
			});
		} finally {
			if (previousUserData === undefined) delete process.env.MAESTRO_USER_DATA;
			else process.env.MAESTRO_USER_DATA = previousUserData;
			fs.rmSync(userData, { recursive: true, force: true });
		}
	});

	it('exposes an injected immutable execution snapshot without disk fallback', () => {
		const snapshot = {
			identity: {
				artifactDigest: 'a'.repeat(64),
				authorizationContentHash: 'c'.repeat(64),
				authorizationSignerKey: 'omp-authorization-signer',
				signerKeyId: 'omp-root',
			},
			text: vi.fn(() => 'verified source'),
			release: vi.fn(),
		};
		const snapshotFor = vi.fn(() => snapshot);
		const manager = new PluginManager({ isEnabled: () => true, snapshotFor });

		expect(manager.getExecutionSnapshot('com.maestro.omp')).toBe(snapshot);
		expect(snapshotFor).toHaveBeenCalledWith('com.maestro.omp');
		expect(
			new PluginManager({ isEnabled: () => true }).getExecutionSnapshot('com.maestro.omp')
		).toBeNull();
	});
});
