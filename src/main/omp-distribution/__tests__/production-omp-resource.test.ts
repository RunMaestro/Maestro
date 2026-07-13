import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

const signedRelease = {
	bundleCommit: '1d627c2f',
	expectedArchiveSha256: 'a'.repeat(64),
	signature: 'A'.repeat(32),
	trustRoot: {
		keyId: 'maestro-omp-plugin-root-2026-07',
		algorithm: 'ed25519',
		publicKey: 'MCowBQYDK2VwAyEAiO7gREXvBefL57LHQbNE8ZlgkDTvj5RpfmEg12nMDrs=',
	},
	pinnedRelease: {
		packageName: '@oh-my-pi/pi-coding-agent',
		version: '16.4.8',
		registryOrigin: 'https://registry.npmjs.org',
		tarballUrl: 'https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/-/pi-coding-agent-16.4.8.tgz',
		integrity:
			'sha512-z7sYIP1ZaDJXOmMRIDmr4wg+J14iOX0Na+rif68NAYPCZ+gglOMUHF7f+qQR7f1pyS2iQpG4pmqbyw+WE4Gsag==',
		npmSigners: [
			{
				keyId: 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U',
				publicKey:
					'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==',
			},
		],
		files: {
			count: 2516,
			treeSha512:
				'sha512-z7sYIP1ZaDJXOmMRIDmr4wg+J14iOX0Na+rif68NAYPCZ+gglOMUHF7f+qQR7f1pyS2iQpG4pmqbyw+WE4Gsag==',
			executable: 'dist/cli.js',
		},
		bundledRuntime: {
			bunExecutable: 'bun/bun.exe',
			ompCliPath: 'omp/dist/cli.js',
			bunSha512:
				'sha512-z7sYIP1ZaDJXOmMRIDmr4wg+J14iOX0Na+rif68NAYPCZ+gglOMUHF7f+qQR7f1pyS2iQpG4pmqbyw+WE4Gsag==',
			ompCliSha512:
				'sha512-z7sYIP1ZaDJXOmMRIDmr4wg+J14iOX0Na+rif68NAYPCZ+gglOMUHF7f+qQR7f1pyS2iQpG4pmqbyw+WE4Gsag==',
			bunVersion: '1.3.14',
		},
		provenance: {
			repository: 'https://github.com/can1357/oh-my-pi',
			workflow: '.github/workflows/ci.yml',
			ref: 'refs/heads/main',
			commit: '01d3fc9b6be922d2209c3211b2063e60565d7398',
		},
	},
	releaseSignature:
		'Y/+5w+q+xiiVY0yrhwtkk7TvkdUGGUasQxVaJUe6DsNTmU+rG5o8N4kyBbpuTgvzAtX8980rU6wQVg+k1BSrBA==',
};

async function productionResource(release = signedRelease) {
	const directory = await mkdtemp(join(tmpdir(), 'maestro-omp-resource-'));
	temporaryDirectories.push(directory);
	await writeFile(join(directory, 'com.maestro.omp.omp'), 'signed OMP artifact');
	await mkdir(join(directory, 'bun'), { recursive: true });
	await mkdir(join(directory, 'omp', 'dist'), { recursive: true });
	await writeFile(join(directory, 'bun', 'bun.exe'), 'bundled bun');
	await writeFile(join(directory, 'omp', 'dist', 'cli.js'), 'bundled OMP');
	await writeFile(join(directory, 'release.json'), JSON.stringify(release));
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

	it('rejects mutable self-signing release root substitution before using its metadata', async () => {
		const directory = await productionResource({
			...signedRelease,
			trustRoot: {
				...signedRelease.trustRoot,
				publicKey: 'MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
			},
		});
		expect(() => loadProductionOmpResource(directory)).toThrow('compiled trust anchor');
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
