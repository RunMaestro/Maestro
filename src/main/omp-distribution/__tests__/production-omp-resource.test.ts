import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProductionOmpResource } from '../production-omp-resource';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

async function productionResource() {
	const directory = await mkdtemp(join(tmpdir(), 'maestro-omp-resource-'));
	temporaryDirectories.push(directory);
	await writeFile(join(directory, 'com.maestro.omp.omp'), 'signed OMP artifact');
	await writeFile(
		join(directory, 'release.json'),
		JSON.stringify({
			bundleCommit: '1d627c2f',
			expectedArchiveSha256: 'a'.repeat(64),
			signature: 'A'.repeat(32),
			trustRoot: {
				keyId: 'maestro-omp-plugin-root-2026-07',
				algorithm: 'ed25519',
				publicKey: 'MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
			},
			pinnedRelease: {
				packageName: '@oh-my-pi/pi-coding-agent',
				version: '16.4.8',
				registryOrigin: 'https://registry.npmjs.org',
				npmKeyIds: ['npm-2026'],
			},
		})
	);
	return directory;
}

describe('production OMP resource', () => {
	it('loads only the pinned signed production resource shape', async () => {
		const directory = await productionResource();
		const resource = loadProductionOmpResource(directory);
		expect(resource.archivePath).toBe(join(directory, 'com.maestro.omp.omp'));
		expect(resource.expectedArchiveSha256).toBe('a'.repeat(64));
		expect(Object.isFrozen(resource.trustRoot)).toBe(true);
		expect(Object.isFrozen(resource.pinnedRelease)).toBe(true);
	});

	it('rejects missing and fixture production resource material', async () => {
		const directory = await productionResource();
		await rm(join(directory, 'com.maestro.omp.omp'));
		expect(() => loadProductionOmpResource(directory)).toThrow('missing bundled OMP archive');

		const fixtureDirectory = await mkdtemp(join(tmpdir(), 'maestro-omp-fixture-resource-'));
		temporaryDirectories.push(fixtureDirectory);
		await writeFile(join(fixtureDirectory, 'com.maestro.omp.omp'), 'fixture artifact');
		await writeFile(join(fixtureDirectory, 'release.json'), JSON.stringify({ fixture: true }));
		expect(() => loadProductionOmpResource(fixtureDirectory)).toThrow('fixture');
	});
});
