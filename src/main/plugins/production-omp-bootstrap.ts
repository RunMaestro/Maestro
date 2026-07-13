import { isAbsolute, resolve } from 'node:path';

import type {
	PinnedOmpRelease,
	ProductionOmpRuntimeResolverDependencies,
} from '../omp-distribution/production-omp-runtime-resolver';
import { createProductionOmpRuntimeResolver } from '../omp-distribution/production-omp-runtime-resolver';
import type {
	ImmutableTrustRoot,
	PluginArtifactSignatureVerifier,
} from '../omp-distribution/plugin-artifact';
import type { InteractiveStopReason } from '../../shared/plugins/interactive-runtime';
import type { OmpArchiveInstallRequest } from './plugin-trust-root-service';
import { OmpPluginTrustRootService } from './plugin-trust-root-service';
import type { InstallResult, PluginExecutionSnapshot } from './plugin-manager';
import type {
	ManagedRuntimeResolver,
	OmpRuntimeAuthResolver,
} from './plugin-managed-runtime-service';
import { PluginManagedRuntimeService } from './plugin-managed-runtime-service';
import { OmpRuntimeProfileService } from './omp-runtime-profile';
import type {
	NativeWorkspaceRootFilesystem,
	NativeWorkspaceRootServiceDeps,
} from './native-workspace-root-service';
import {
	createOmpSandboxHostHandlers,
	type OmpSandboxHostHandlerDeps,
	type OmpSandboxHostHandlerSeam,
} from './omp-host-safety-brokers';
import { NativeWorkspaceRootService } from './native-workspace-root-service';

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

export interface ProductionOmpBootstrapInput {
	readonly pluginsDir: string;
	readonly archivePath: string;
	readonly expectedArchiveSha256: string;
	readonly trustRoot: ImmutableTrustRoot;
	readonly verifySignature: PluginArtifactSignatureVerifier;
	readonly pinnedRelease: PinnedOmpRelease;
	/**
	 * Test seam only. Production supplies the narrower resolver dependencies so this
	 * composition root creates the resolver from the pinned release itself.
	 */
	readonly resolver?: ManagedRuntimeResolver;
	readonly runtimeResolverDependencies?: Omit<
		ProductionOmpRuntimeResolverDependencies,
		'pinnedRelease' | 'managedInstallOptIn'
	>;
	/** Managed installation is never enabled merely because system discovery failed. */
	readonly managedInstallOptIn?: () => boolean;
	/** Host-only dependencies for the opaque OMP tool/URI/auth/export broker seam. */
	readonly ompSandboxHandlerDeps?: Omit<OmpSandboxHostHandlerDeps, 'roots' | 'activation'>;
	/** App-owned sterile OMP launch profile; defaults to a new host-owned profile service. */
	readonly ompRuntimeProfile?: OmpRuntimeProfileService;
	/** Host-only explicit credential resolver; it never enters plugin or renderer IPC. */
	readonly ompAuthResolver?: OmpRuntimeAuthResolver;
	readonly activation: NativeWorkspaceRootServiceDeps['activation'];
	readonly chooseDirectory: NativeWorkspaceRootServiceDeps['chooseDirectory'];
	readonly filesystem?: NativeWorkspaceRootFilesystem;
}

/** Immutable release/trust inputs compiled into a production host. */
export type ProductionOmpBootstrapConfiguration = Omit<
	ProductionOmpBootstrapInput,
	'activation' | 'chooseDirectory'
>;

export interface ProductionOmpArchiveBootstrapManager {
	readonly installOrUpdateArchive: (request: OmpArchiveInstallRequest) => InstallResult;
}

export interface ProductionOmpBootstrap {
	readonly ompArchiveInstaller: Pick<OmpPluginTrustRootService, 'installOrUpdateArchive'>;
	readonly snapshotFor: (pluginId: string) => PluginExecutionSnapshot | null;
	readonly runtimeResolver: ManagedRuntimeResolver;
	readonly workspaceRoots: NativeWorkspaceRootService;
	readonly managedRuntime: PluginManagedRuntimeService;
	/** Closed host callback authority, absent unless production injects broker dependencies. */
	readonly ompSandboxHandlers?: OmpSandboxHostHandlerSeam;
	bootstrapBundledArchive: (manager: ProductionOmpArchiveBootstrapManager) => InstallResult;
	installExternalArchive: (
		manager: ProductionOmpArchiveBootstrapManager,
		request: Omit<OmpArchiveInstallRequest, 'owner'>
	) => InstallResult;
	teardown: (ownerPluginId: string, reason?: InteractiveStopReason) => Promise<void>;
}

/**
 * The sole production composition root for OMP's signed plugin and supervised
 * controller. It has no settings fallback: every release, signer, verifier,
 * digest, archive location, and resolver input arrives as immutable host input.
 */
export function createProductionOmpBootstrap(
	input: ProductionOmpBootstrapInput
): ProductionOmpBootstrap {
	assertProductionInput(input);
	const runtimeResolver = resolveRuntimeResolver(input);
	const workspaceRoots = new NativeWorkspaceRootService({
		activation: input.activation,
		chooseDirectory: input.chooseDirectory,
		...(input.filesystem ? { filesystem: input.filesystem } : {}),
	});
	const ompSandboxHandlers = input.ompSandboxHandlerDeps
		? createOmpSandboxHostHandlers({
				...input.ompSandboxHandlerDeps,
				roots: workspaceRoots,
				activation: input.activation,
			})
		: undefined;
	const managedRuntime = new PluginManagedRuntimeService({
		activation: input.activation,
		...(ompSandboxHandlers ? { ompSandboxHandlers } : {}),
		...(input.ompRuntimeProfile ? { profile: input.ompRuntimeProfile } : {}),
		...(input.ompAuthResolver ? { authResolver: input.ompAuthResolver } : {}),
		roots: workspaceRoots,
		runtime: runtimeResolver,
	});
	const trustService = new OmpPluginTrustRootService({
		pluginsDir: resolve(input.pluginsDir),
		trustRoot: input.trustRoot,
		verifySignature: input.verifySignature,
	});
	const bundledRequest = Object.freeze({
		archivePath: resolve(input.archivePath),
		expectedSha256: input.expectedArchiveSha256.toLowerCase(),
		owner: 'bundle' as const,
	});

	return Object.freeze({
		ompArchiveInstaller: trustService,
		snapshotFor: (pluginId: string): PluginExecutionSnapshot | null => {
			if (pluginId !== 'com.maestro.omp') return null;
			const snapshot = trustService.getActiveSnapshot();
			if (!snapshot) return null;
			return {
				identity: {
					artifactDigest: snapshot.identity.artifactSha256,
					authorizationContentHash: snapshot.identity.authorizationContentHash,
					authorizationSignerKey: snapshot.identity.authorizationSignerKey,
					signerKeyId: snapshot.identity.signerKeyId,
				},
				text: (filePath: string) => snapshot.text(filePath),
				release: () => undefined,
			};
		},
		runtimeResolver,
		workspaceRoots,
		managedRuntime,
		...(ompSandboxHandlers ? { ompSandboxHandlers } : {}),
		bootstrapBundledArchive: (manager: ProductionOmpArchiveBootstrapManager) =>
			installRequired(manager, bundledRequest),
		installExternalArchive: (
			manager: ProductionOmpArchiveBootstrapManager,
			request: Omit<OmpArchiveInstallRequest, 'owner'>
		) => installRequired(manager, Object.freeze({ ...request, owner: 'external' as const })),
		teardown: async (ownerPluginId: string, reason: InteractiveStopReason = 'shutdown') => {
			workspaceRoots.revokeAll();
			await managedRuntime.revokeOwner(ownerPluginId, reason);
		},
	});
}

function resolveRuntimeResolver(input: ProductionOmpBootstrapInput): ManagedRuntimeResolver {
	if (input.resolver) return input.resolver;
	if (!input.runtimeResolverDependencies) {
		throw new Error('production OMP runtime resolver is required');
	}
	return createProductionOmpRuntimeResolver({
		...input.runtimeResolverDependencies,
		pinnedRelease: input.pinnedRelease,
		managedInstallOptIn: input.managedInstallOptIn ?? (() => false),
	});
}

function installRequired(
	manager: ProductionOmpArchiveBootstrapManager,
	request: OmpArchiveInstallRequest
): InstallResult {
	const result = manager.installOrUpdateArchive(request);
	if (!result.success)
		throw new Error(result.error ?? 'verified bundled OMP archive installation failed');
	return result;
}

function assertProductionInput(input: ProductionOmpBootstrapInput): void {
	if (!isAbsolute(input.pluginsDir))
		throw new Error('production OMP plugin directory must be absolute');
	if (!isAbsolute(input.archivePath))
		throw new Error('production OMP archive path must be absolute');
	if (!SHA256_PATTERN.test(input.expectedArchiveSha256)) {
		throw new Error('production OMP archive requires a published SHA-256');
	}
	if (!Object.isFrozen(input.trustRoot)) {
		throw new Error('production OMP trust root must be immutable');
	}
	if (
		input.trustRoot.algorithm !== 'ed25519' ||
		input.trustRoot.keyId.trim() === '' ||
		input.trustRoot.publicKey.trim() === '' ||
		isFixture(input.trustRoot.keyId) ||
		isFixture(input.trustRoot.publicKey)
	) {
		throw new Error('production OMP trust root is invalid');
	}
	if (!Object.isFrozen(input.pinnedRelease)) {
		throw new Error('production OMP release metadata must be immutable');
	}
	if (
		input.pinnedRelease.packageName !== '@oh-my-pi/pi-coding-agent' ||
		input.pinnedRelease.version !== '16.4.8' ||
		input.pinnedRelease.registryOrigin !== 'https://registry.npmjs.org' ||
		input.pinnedRelease.npmKeyIds.length === 0 ||
		input.pinnedRelease.npmKeyIds.some((keyId) => keyId.trim() === '')
	) {
		throw new Error('production OMP release metadata is invalid');
	}
	if (isFixture(input.archivePath) || isFixture(input.pluginsDir)) {
		throw new Error('production OMP resources cannot use fixture paths');
	}
	if (typeof input.verifySignature !== 'function') {
		throw new Error('production OMP signature verifier is required');
	}
}

function isFixture(value: string): boolean {
	return value.toLowerCase().includes('fixture');
}
