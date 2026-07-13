import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	buildPluginArtifact,
	type ImmutableTrustRoot,
} from '../../omp-distribution/plugin-artifact';
import { createProductionOmpBootstrap } from '../production-omp-bootstrap';
import { computePluginContentHash } from '../plugin-signature';
import type { PinnedOmpRelease } from '../../omp-distribution/production-omp-runtime-resolver';
import type {
	ManagedRuntimeResolver,
	VerifiedRuntimeLaunch,
} from '../plugin-managed-runtime-service';
import type { RuntimeActivationContext } from '../native-workspace-root-service';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

function productionArtifact() {
	const directory = `${tmpdir()}${join('maestro-omp-bootstrap-')}`;
	const { privateKey, publicKey } = generateKeyPairSync('ed25519');
	const trustRoot: ImmutableTrustRoot = Object.freeze({
		keyId: 'maestro-omp-plugin-root-2026-07',
		algorithm: 'ed25519',
		publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
	});
	const artifact = buildPluginArtifact({
		pluginId: 'com.maestro.omp',
		version: '1.0.0',
		contractSha256: 'a'.repeat(64),
		trustRoot,
		files: [
			{
				path: 'plugin.json',
				content: Buffer.from(
					JSON.stringify({
						id: 'com.maestro.omp',
						name: 'OMP',
						version: '1.0.0',
						tier: 1,
						maestro: { minHostApi: '1.0.0' },
						entry: 'index.js',
						permissions: [],
					})
				),
			},
			{ path: 'index.js', content: Buffer.from('export {};') },
		],
		sign: (payload) => sign(null, payload, privateKey).toString('base64url'),
	});
	return {
		directory,
		trustRoot,
		artifact,
		verifySignature: (payload: Uint8Array, signature: string) =>
			verify(null, payload, publicKey, Buffer.from(signature, 'base64url')),
	};
}

async function writeArtifact() {
	const input = productionArtifact();
	const directory = await mkdtemp(input.directory);
	temporaryDirectories.push(directory);
	const archivePath = join(directory, 'com.maestro.omp.omp');
	await writeFile(archivePath, input.artifact);
	return {
		...input,
		directory,
		archivePath,
		expectedSha256: createHash('sha256').update(input.artifact).digest('hex'),
	};
}

const pinnedRelease: PinnedOmpRelease = Object.freeze({
	packageName: '@oh-my-pi/pi-coding-agent',
	version: '16.4.8',
	registryOrigin: 'https://registry.npmjs.org',
	npmKeyIds: Object.freeze(['npm-2026']),
});

describe('production OMP bootstrap', () => {
	it('installs the verified bundled archive on cold bootstrap and exposes no runtime before root consent', async () => {
		const input = await writeArtifact();
		const resolver: ManagedRuntimeResolver = {
			resolveSystem: vi.fn(async () => null),
			managedInstallAllowed: vi.fn(() => false),
			resolveManaged: vi.fn(async (): Promise<VerifiedRuntimeLaunch> => {
				throw new Error('managed installation is disabled');
			}),
		};
		let activation: RuntimeActivationContext | null = null;
		const bootstrap = createProductionOmpBootstrap({
			pluginsDir: join(input.directory, 'plugins'),
			archivePath: input.archivePath,
			expectedArchiveSha256: input.expectedSha256,
			trustRoot: input.trustRoot,
			verifySignature: input.verifySignature,
			pinnedRelease,
			resolver,
			activation: () => activation,
			chooseDirectory: async () => null,
		});

		const manager = {
			installOrUpdateArchive: vi.fn((request) => {
				bootstrap.ompArchiveInstaller.installOrUpdateArchive(request);
				return { success: true };
			}),
		};
		const installed = bootstrap.bootstrapBundledArchive(manager);
		expect(installed.success).toBe(true);
		expect(manager.installOrUpdateArchive).toHaveBeenCalledWith({
			archivePath: input.archivePath,
			expectedSha256: input.expectedSha256,
			owner: 'bundle',
		});
		await expect(bootstrap.managedRuntime.requestWorkspaceRoot()).rejects.toThrow(
			'interactive runtime owner is unavailable'
		);
		expect(resolver.resolveSystem).not.toHaveBeenCalled();

		activation = {
			ownerPluginId: 'com.maestro.omp',
			generation: 1n,
			authorization: {
				signatureTrusted: true,
				enabled: true,
				hostCompatible: true,
				userConsented: true,
				workspaceRootCurrent: true,
				grants: [],
			},
		};
		expect(await bootstrap.managedRuntime.requestWorkspaceRoot()).toBeNull();
	});

	it('derives production resource authorization identity from the same canonical file hash as installation', async () => {
		const input = await writeArtifact();
		const bootstrap = createProductionOmpBootstrap({
			pluginsDir: join(input.directory, 'plugins'),
			archivePath: input.archivePath,
			expectedArchiveSha256: input.expectedSha256,
			trustRoot: input.trustRoot,
			verifySignature: input.verifySignature,
			pinnedRelease,
			resolver: {
				resolveSystem: async () => null,
				managedInstallAllowed: () => false,
				resolveManaged: async () => {
					throw new Error('managed installation is disabled');
				},
			},
			activation: () => null,
			chooseDirectory: async () => null,
		});
		bootstrap.bootstrapBundledArchive({
			installOrUpdateArchive: (request) => {
				bootstrap.ompArchiveInstaller.installOrUpdateArchive(request);
				return { success: true };
			},
		});

		const snapshot = bootstrap.snapshotFor('com.maestro.omp');
		expect(snapshot).not.toBeNull();
		expect(snapshot?.identity.authorizationContentHash).toBe(
			computePluginContentHash(join(input.directory, 'plugins', 'com.maestro.omp'))
		);
		expect(snapshot?.identity.authorizationContentHash).not.toBe(
			snapshot?.identity.artifactDigest
		);
		expect(snapshot?.identity.authorizationSignerKey).toBe(input.trustRoot.publicKey);
		expect(snapshot?.identity.authorizationSignerKey).not.toBe(snapshot?.identity.signerKeyId);
	});

	it('exposes workspace run in the production catalog only when a supervised process is injected', async () => {
		const input = await writeArtifact();
		const bootstrap = createProductionOmpBootstrap({
			pluginsDir: join(input.directory, 'plugins'),
			archivePath: input.archivePath,
			expectedArchiveSha256: input.expectedSha256,
			trustRoot: input.trustRoot,
			verifySignature: input.verifySignature,
			pinnedRelease,
			resolver: {
				resolveSystem: async () => null,
				managedInstallAllowed: () => false,
				resolveManaged: async () => {
					throw new Error('managed installation is disabled');
				},
			},
			activation: () => null,
			chooseDirectory: async () => null,
			ompSandboxHandlerDeps: {
				workspaceRoot: () => null,
				approve: async () => true,
				process: {
					run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
					cancel: () => undefined,
					revoke: () => undefined,
				},
				auth: {
					providers: [],
					allowedOrigins: new Set<string>(),
					openAuthorization: async () => {
						throw new Error('no provider');
					},
					exchangeCode: async () => {
						throw new Error('no provider');
					},
				},
				export: { chooseDirectory: async () => null },
			},
		});
		expect(bootstrap.ompSandboxHandlers?.tools.catalog().map(({ name }) => name)).toContain(
			'maestro.workspace.run'
		);
	});

	it('uses managed runtime only when its explicit production opt-in is true', async () => {
		const input = await writeArtifact();
		const resolver: ManagedRuntimeResolver = {
			resolveSystem: vi.fn(async () => null),
			managedInstallAllowed: vi.fn(() => true),
			resolveManaged: vi.fn(async (): Promise<VerifiedRuntimeLaunch> => {
				const launch: VerifiedRuntimeLaunch = {
					executablePath: '/verified/omp',
					prefixArgs: [],
					fileIdentities: [{ canonicalPath: '/verified/omp', identity: 'verified-omp' }],
					version: '16.4.8',
					provenance: 'verified',
					revalidateForLaunch: async () => launch,
				};
				return Object.freeze(launch);
			}),
		};
		const bootstrap = createProductionOmpBootstrap({
			pluginsDir: join(input.directory, 'plugins'),
			archivePath: input.archivePath,
			expectedArchiveSha256: input.expectedSha256,
			trustRoot: input.trustRoot,
			verifySignature: input.verifySignature,
			pinnedRelease,
			resolver,
			activation: () => null,
			chooseDirectory: async () => null,
			managedInstallOptIn: () => true,
		});
		expect(bootstrap.runtimeResolver.managedInstallAllowed()).toBe(true);
		expect(resolver.managedInstallAllowed).toHaveBeenCalledOnce();
	});

	it('creates the production resolver and keeps its managed fallback disabled until opt-in', async () => {
		const input = await writeArtifact();
		const runtimeResolverDependencies = {
			managedPackageFetcher: {
				fetchMetadata: async () => {
					throw new Error('not fetched during startup');
				},
				fetchTarball: async () => {
					throw new Error('not fetched during startup');
				},
				verifyNpmSignature: () => false,
			},
			provenanceVerifier: {
				verifySystemPublisherProof: async () => false,
				verifySlsaAttestation: async () => false,
			},
			managedRuntimeRoot: join(input.directory, 'managed-runtime'),
		};
		const common = {
			pluginsDir: join(input.directory, 'plugins'),
			archivePath: input.archivePath,
			expectedArchiveSha256: input.expectedSha256,
			trustRoot: input.trustRoot,
			verifySignature: input.verifySignature,
			pinnedRelease,
			runtimeResolverDependencies,
			activation: () => null,
			chooseDirectory: async () => null,
		};
		expect(createProductionOmpBootstrap(common).runtimeResolver.managedInstallAllowed()).toBe(
			false
		);
		expect(
			createProductionOmpBootstrap({
				...common,
				managedInstallOptIn: () => true,
			}).runtimeResolver.managedInstallAllowed()
		).toBe(true);
	});

	it('fails closed when a production resource is missing or its immutable trust input is wrong', async () => {
		const input = await writeArtifact();
		expect(() =>
			createProductionOmpBootstrap({
				pluginsDir: join(input.directory, 'plugins'),
				archivePath: join(input.directory, 'missing.omp'),
				expectedArchiveSha256: input.expectedSha256,
				trustRoot: input.trustRoot,
				verifySignature: input.verifySignature,
				pinnedRelease,
				resolver: undefined,
				activation: () => null,
				chooseDirectory: async () => null,
			})
		).toThrow('production OMP runtime resolver is required');

		const wrongTrustRoot = Object.freeze({ ...input.trustRoot, keyId: 'other-production-root' });
		const bootstrap = createProductionOmpBootstrap({
			pluginsDir: join(input.directory, 'plugins'),
			archivePath: input.archivePath,
			expectedArchiveSha256: input.expectedSha256,
			trustRoot: wrongTrustRoot,
			verifySignature: input.verifySignature,
			pinnedRelease,
			resolver: {
				resolveSystem: async () => null,
				managedInstallAllowed: () => false,
				resolveManaged: async () => {
					throw new Error('not enabled');
				},
			},
			activation: () => null,
			chooseDirectory: async () => null,
		});
		expect(() =>
			bootstrap.bootstrapBundledArchive({
				installOrUpdateArchive: (request) => {
					bootstrap.ompArchiveInstaller.installOrUpdateArchive(request);
					return { success: true };
				},
			})
		).toThrow('trust root mismatch');
	});

	it('revokes root authority before managed runtime teardown', async () => {
		const input = await writeArtifact();
		const bootstrap = createProductionOmpBootstrap({
			pluginsDir: join(input.directory, 'plugins'),
			archivePath: input.archivePath,
			expectedArchiveSha256: input.expectedSha256,
			trustRoot: input.trustRoot,
			verifySignature: input.verifySignature,
			pinnedRelease,
			resolver: {
				resolveSystem: async () => null,
				managedInstallAllowed: () => false,
				resolveManaged: async () => {
					throw new Error('not enabled');
				},
			},
			activation: () => null,
			chooseDirectory: async () => null,
		});
		const revokeAll = vi.spyOn(bootstrap.workspaceRoots, 'revokeAll');
		const revokeOwner = vi.spyOn(bootstrap.managedRuntime, 'revokeOwner');
		await bootstrap.teardown('com.maestro.omp', 'shutdown');
		expect(revokeAll).toHaveBeenCalledBefore(revokeOwner);
		expect(revokeOwner).toHaveBeenCalledWith('com.maestro.omp', 'shutdown');
	});
});
