import { createHash } from 'crypto';
import { gzipSync } from 'zlib';
import { describe, expect, it } from 'vitest';
import {
	createBoundedNpmPackageFetcher,
	createProductionOmpRuntimeResolver,
	type BoundedHttpsRequester,
	type ManagedRuntimePathInspection,
	type ManagedRuntimePathInspector,
	type PinnedOmpRelease,
	type ProductionOmpRuntimeResolverDependencies,
	type SystemRuntimeCandidate,
} from '../production-omp-runtime-resolver';
import type { ManagedPackageFetcher } from '../managed-package-source';
import type { RuntimeFileSystem } from '../runtime-installer';

function packageTarball(): Buffer {
	const entry = (name: string, content: string): Buffer => {
		const header = Buffer.alloc(512);
		header.write(name, 0);
		header.write('0000777\0', 100);
		header.write('0000000\0', 108);
		header.write('0000000\0', 116);
		header.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
		header.write('00000000000\0', 136);
		header.write('        ', 148);
		header.write('ustar\0', 257);
		header.write('00', 263);
		let checksum = 0;
		for (const byte of header) checksum += byte;
		header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
		return Buffer.concat([
			header,
			Buffer.from(content),
			Buffer.alloc((512 - (content.length % 512)) % 512),
		]);
	};
	return gzipSync(
		Buffer.concat([
			entry('package/dist/cli.js', 'verified-cli'),
			entry('package/LICENSE', 'MIT'),
			Buffer.alloc(1024),
		])
	);
}

const tarball = packageTarball();
const tarballIntegrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
const systemFingerprint = `sha512-${createHash('sha512').update('system-omp').digest('base64')}`;

function release(): PinnedOmpRelease {
	return Object.freeze({
		packageName: '@oh-my-pi/pi-coding-agent',
		version: '16.4.8',
		registryOrigin: 'https://registry.npmjs.org',
		npmKeyIds: Object.freeze(['SHA256:trusted-publisher']),
		system: Object.freeze({
			publisher: 'Oh My P.I. Inc.',
			fingerprintSha512: systemFingerprint,
		}),
	});
}

function verifiedFetcher(overrides: Partial<ManagedPackageFetcher> = {}): ManagedPackageFetcher {
	const digest = tarballIntegrity.slice('sha512-'.length);
	return {
		fetchMetadata: async () => ({
			packageJson: JSON.stringify({
				name: '@oh-my-pi/pi-coding-agent',
				version: '16.4.8',
				bin: { pi: 'dist/cli.js' },
			}),
			integrity: tarballIntegrity,
			provenance: {
				signatures: [
					{
						keyid: 'SHA256:trusted-publisher',
						sig: 'valid-signature',
						integrity: tarballIntegrity,
					},
				],
				attestations: [
					{
						predicateType: 'https://slsa.dev/provenance/v1',
						subject: [{ name: '@oh-my-pi/pi-coding-agent', digest: { sha512: digest } }],
					},
				],
			},
		}),
		fetchTarball: async () => tarball,
		verifyNpmSignature: (keyId, signature) =>
			keyId === 'SHA256:trusted-publisher' && signature === 'valid-signature',
		...overrides,
	};
}

function memoryFs(): RuntimeFileSystem & { readonly files: Map<string, Uint8Array> } {
	const files = new Map<string, Uint8Array>();
	const directories = new Set<string>();
	return {
		files,
		async mkdir(path) {
			directories.add(path);
		},
		async writeFile(path, content) {
			files.set(path, Buffer.from(content));
		},
		async readFile(path) {
			const file = files.get(path);
			if (!file) throw new Error(`ENOENT ${path}`);
			return Buffer.from(file);
		},
		async exists(path) {
			return files.has(path) || directories.has(path);
		},
		async rename(from, to) {
			for (const directory of [...directories]) {
				if (directory === from || directory.startsWith(`${from}/`)) {
					directories.delete(directory);
					directories.add(`${to}${directory.slice(from.length)}`);
				}
			}
			for (const [path, content] of [...files]) {
				if (path.startsWith(`${from}/`)) {
					files.delete(path);
					files.set(`${to}${path.slice(from.length)}`, content);
				}
			}
		},
		async remove(path) {
			for (const directory of [...directories]) {
				if (directory === path || directory.startsWith(`${path}/`)) directories.delete(directory);
			}
			for (const file of [...files.keys()]) {
				if (file === path || file.startsWith(`${path}/`)) files.delete(file);
			}
		},
		async acquireLock(path) {
			if (files.has(path)) throw new Error('managed runtime install is already locked');
			files.set(path, Buffer.from('locked'));
			return async () => {
				files.delete(path);
			};
		},
	};
}

function pathInspector(
	overrides: Partial<ManagedRuntimePathInspection> = {}
): ManagedRuntimePathInspector {
	return {
		canonicalize: async (path) => path,
		inspect: async () => ({
			isRegularFile: true,
			isReparsePoint: false,
			isUserWritable: false,
			fingerprintSha512: systemFingerprint,
			...overrides,
		}),
	};
}

function systemCandidate(overrides: Partial<SystemRuntimeCandidate> = {}): SystemRuntimeCandidate {
	return {
		path: 'C:/Program Files/OMP/omp.exe',
		version: '16.4.8',
		publisher: 'Oh My P.I. Inc.',
		publisherProof: Object.freeze({ kind: 'windows-authenticode' }),
		...overrides,
	};
}

function dependencies(
	overrides: Partial<ProductionOmpRuntimeResolverDependencies> = {}
): ProductionOmpRuntimeResolverDependencies {
	return {
		pinnedRelease: release(),
		managedInstallOptIn: () => true,
		pathInspector: pathInspector(),
		systemPackageLocator: {
			locate: async () => [systemCandidate()],
		},
		provenanceVerifier: {
			verifySystemPublisherProof: async (candidate, expected) =>
				candidate.publisher === expected.publisher,
			verifySlsaAttestation: async () => true,
		},
		managedPackageFetcher: verifiedFetcher(),
		runtimeFileSystem: memoryFs(),
		managedRuntimeRoot: 'C:/ProgramData/Maestro/omp-runtime',
		...overrides,
	};
}

describe('ProductionOmpRuntimeResolver', () => {
	it('returns only an enrolled canonical candidate with its pinned immutable fingerprint', async () => {
		const resolver = createProductionOmpRuntimeResolver(
			dependencies({
				enrollment: Object.freeze({
					canonicalPath: 'C:/Program Files/OMP/omp.exe',
					fingerprintSha512: systemFingerprint,
				}),
				systemPackageLocator: {
					locate: async () => [systemCandidate({ path: 'C:/shadow/omp.exe' })],
				},
			})
		);

		await expect(resolver.resolveSystem()).resolves.toEqual({
			executable: 'C:/Program Files/OMP/omp.exe',
			provenance: 'verified',
			version: '16.4.8',
		});
	});

	it('rejects PATH shadows, writable/reparse candidates, and fingerprint mismatches without execution', async () => {
		const shadows = ['C:/shadow/omp.exe', 'C:/Program Files/OMP/omp.exe'];
		for (const inspector of [
			pathInspector({ isUserWritable: true }),
			pathInspector({ isReparsePoint: true }),
			pathInspector({ fingerprintSha512: 'sha512-ZmFrZQ==' }),
		]) {
			const resolver = createProductionOmpRuntimeResolver(
				dependencies({
					pathInspector: inspector,
					systemPackageLocator: {
						locate: async () => shadows.map((path) => systemCandidate({ path })),
					},
				})
			);
			await expect(resolver.resolveSystem()).resolves.toBeNull();
		}
	});

	it('requires immutable system manifest and publisher proof before accepting a package candidate', async () => {
		const missingManifest = createProductionOmpRuntimeResolver(
			dependencies({ pinnedRelease: Object.freeze({ ...release(), system: undefined }) })
		);
		await expect(missingManifest.resolveSystem()).resolves.toBeNull();

		const rejectedProof = createProductionOmpRuntimeResolver(
			dependencies({
				provenanceVerifier: {
					verifySystemPublisherProof: async () => false,
					verifySlsaAttestation: async () => true,
				},
			})
		);
		await expect(rejectedProof.resolveSystem()).resolves.toBeNull();
	});

	it('fails closed for opt-out or missing production provenance inputs', async () => {
		const optOut = createProductionOmpRuntimeResolver(
			dependencies({ managedInstallOptIn: () => false })
		);
		expect(optOut.managedInstallAllowed()).toBe(false);
		await expect(optOut.resolveManaged()).rejects.toThrow('disabled');

		const missingKeys = createProductionOmpRuntimeResolver(
			dependencies({ pinnedRelease: Object.freeze({ ...release(), npmKeyIds: Object.freeze([]) }) })
		);
		expect(missingKeys.managedInstallAllowed()).toBe(false);
		await expect(missingKeys.resolveManaged()).rejects.toThrow('trust inputs');
	});

	it('rejects wrong package, version, SRI, signature, and SLSA evidence before atomic installation', async () => {
		const cases: Array<Partial<ManagedPackageFetcher>> = [
			{
				fetchMetadata: async () => ({
					...(await verifiedFetcher().fetchMetadata()),
					packageJson: JSON.stringify({
						name: 'wrong-package',
						version: '16.4.8',
						bin: { pi: 'dist/cli.js' },
					}),
				}),
			},
			{
				fetchMetadata: async () => ({
					...(await verifiedFetcher().fetchMetadata()),
					packageJson: JSON.stringify({
						name: '@oh-my-pi/pi-coding-agent',
						version: '16.4.7',
						bin: { pi: 'dist/cli.js' },
					}),
				}),
			},
			{
				fetchMetadata: async () => ({
					...(await verifiedFetcher().fetchMetadata()),
					integrity: 'sha512-ZmFrZQ==',
				}),
			},
			{
				verifyNpmSignature: () => false,
			},
			{
				fetchMetadata: async () => ({
					...(await verifiedFetcher().fetchMetadata()),
					provenance: { signatures: [], attestations: [] },
				}),
			},
		];
		for (const fetcher of cases) {
			const fs = memoryFs();
			const resolver = createProductionOmpRuntimeResolver(
				dependencies({ managedPackageFetcher: verifiedFetcher(fetcher), runtimeFileSystem: fs })
			);
			await expect(resolver.resolveManaged()).rejects.toThrow();
			expect([...fs.files.keys()].some((path) => path.includes('/16.4.8/'))).toBe(false);
		}
	});

	it('verifies, atomically installs, caches, and invalidates the managed executable', async () => {
		const fs = memoryFs();
		let fetches = 0;
		const fetcher = verifiedFetcher({
			fetchMetadata: async () => {
				fetches += 1;
				return verifiedFetcher().fetchMetadata();
			},
		});
		const resolver = createProductionOmpRuntimeResolver(
			dependencies({ managedPackageFetcher: fetcher, runtimeFileSystem: fs })
		);
		await expect(
			Promise.all([resolver.resolveManaged(), resolver.resolveManaged()])
		).resolves.toEqual([
			{
				executable: 'C:/ProgramData/Maestro/omp-runtime/16.4.8/dist/cli.js',
				provenance: 'verified',
				version: '16.4.8',
			},
			{
				executable: 'C:/ProgramData/Maestro/omp-runtime/16.4.8/dist/cli.js',
				provenance: 'verified',
				version: '16.4.8',
			},
		]);
		expect(fetches).toBe(1);
		expect(fs.files.has('C:/ProgramData/Maestro/omp-runtime/16.4.8/maestro-runtime.json')).toBe(
			true
		);
		expect(
			fs.files.has('C:/ProgramData/Maestro/omp-runtime/16.4.8/THIRD_PARTY_NOTICES/LICENSE')
		).toBe(true);

		resolver.invalidate();
		await resolver.resolveManaged();
		expect(fetches).toBe(2);
	});
});

describe('bounded HTTPS npm fetcher', () => {
	it('requires the exact HTTPS registry origin and rejects cross-origin redirects', async () => {
		const requester: BoundedHttpsRequester = async () => ({
			statusCode: 302,
			headers: { location: 'https://evil.example/tarball' },
			body: Buffer.alloc(0),
		});
		const fetcher = createBoundedNpmPackageFetcher({
			registryOrigin: 'https://registry.npmjs.org',
			metadataUrl: 'https://registry.npmjs.org/@oh-my-pi%2fpi-coding-agent/16.4.8',
			provenanceUrl:
				'https://registry.npmjs.org/-/npm/v1/attestations/@oh-my-pi/pi-coding-agent@16.4.8',
			requester,
			verifyNpmSignature: () => false,
		});
		await expect(fetcher.fetchMetadata()).rejects.toThrow('redirect');
	});

	it('rejects a wrong tarball origin and oversized registry responses', async () => {
		const metadata = {
			name: '@oh-my-pi/pi-coding-agent',
			version: '16.4.8',
			bin: { pi: 'dist/cli.js' },
			dist: { integrity: tarballIntegrity, tarball: 'https://evil.example/omp.tgz' },
		};
		const wrongOrigin: BoundedHttpsRequester = async () => ({
			statusCode: 200,
			headers: {},
			body: Buffer.from(JSON.stringify(metadata)),
		});
		const fetcher = createBoundedNpmPackageFetcher({
			registryOrigin: 'https://registry.npmjs.org',
			metadataUrl: 'https://registry.npmjs.org/metadata',
			provenanceUrl: 'https://registry.npmjs.org/provenance',
			requester: wrongOrigin,
			verifyNpmSignature: () => false,
		});
		await expect(fetcher.fetchTarball()).rejects.toThrow('origin');

		const oversized: BoundedHttpsRequester = async () => ({
			statusCode: 200,
			headers: {},
			body: Buffer.alloc(1025),
		});
		const bounded = createBoundedNpmPackageFetcher({
			registryOrigin: 'https://registry.npmjs.org',
			metadataUrl: 'https://registry.npmjs.org/metadata',
			provenanceUrl: 'https://registry.npmjs.org/provenance',
			requester: oversized,
			verifyNpmSignature: () => false,
			maxMetadataBytes: 1024,
		});
		await expect(bounded.fetchMetadata()).rejects.toThrow('response exceeds');
	});
});
