import { isAbsolute } from 'node:path';
import type { ProductionOmpBootstrapConfiguration } from './production-omp-bootstrap';

/**
 * Immutable host dependencies that must be supplied before the production main
 * module starts evaluating. They are intentionally unavailable to renderer and
 * preload processes.
 */
export interface PluginRuntimeStartupDependencies {
	readonly productionOmp?: ProductionOmpBootstrapConfiguration;
}

type StartupConfigurationState = 'unconfigured' | 'configured' | 'consumed';
type UnknownRecord = Record<string, unknown>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const EMPTY_STARTUP_DEPENDENCIES: PluginRuntimeStartupDependencies = Object.freeze({});
const STARTUP_DEPENDENCY_KEYS: Readonly<Record<string, true>> = {
	productionOmp: true,
};
const PRODUCTION_OMP_CONFIGURATION_KEYS: Readonly<Record<string, true>> = {
	pluginsDir: true,
	archivePath: true,
	expectedArchiveSha256: true,
	trustRoot: true,
	verifySignature: true,
	pinnedRelease: true,
	resolver: true,
	runtimeResolverDependencies: true,
	managedInstallOptIn: true,
	ompSandboxHandlerDeps: true,
	ompRuntimeProfile: true,
	ompAuthResolver: true,
	filesystem: true,
};
const TRUST_ROOT_KEYS: Readonly<Record<string, true>> = {
	keyId: true,
	algorithm: true,
	publicKey: true,
};
const PINNED_RELEASE_KEYS: Readonly<Record<string, true>> = {
	packageName: true,
	version: true,
	registryOrigin: true,
	npmKeyIds: true,
	system: true,
};
const PINNED_SYSTEM_RELEASE_KEYS: Readonly<Record<string, true>> = {
	publisher: true,
	fingerprintSha512: true,
};

let state: StartupConfigurationState = 'unconfigured';
let startupDependencies: PluginRuntimeStartupDependencies = EMPTY_STARTUP_DEPENDENCIES;

/**
 * Supplies the complete signed-plugin runtime identity exactly once, before the
 * production main module evaluates. Invalid input is rejected before it can
 * reach the plugin bootstrap composition root.
 */
export function configurePluginRuntimeStartupDependencies(
	dependencies: PluginRuntimeStartupDependencies
): void {
	if (state === 'consumed') {
		throw new Error('plugin runtime startup dependencies have already been read');
	}
	if (state === 'configured') {
		throw new Error('plugin runtime startup dependencies are already configured');
	}

	assertStartupDependencies(dependencies);
	freezeRecursively(dependencies);
	startupDependencies = dependencies;
	state = 'configured';
}

/**
 * Returns the immutable startup snapshot. The first read seals the default or
 * configured dependencies, preventing any late bootstrap override.
 */
export function readPluginRuntimeStartupDependencies(): PluginRuntimeStartupDependencies {
	state = 'consumed';
	return startupDependencies;
}

/** Keeps production's packaged resource path as the default when no override exists. */
export function resolveProductionOmpStartupConfiguration(
	dependencies: PluginRuntimeStartupDependencies,
	packagedConfiguration: ProductionOmpBootstrapConfiguration | undefined
): ProductionOmpBootstrapConfiguration | undefined {
	return dependencies.productionOmp ?? packagedConfiguration;
}

function assertStartupDependencies(
	value: unknown
): asserts value is PluginRuntimeStartupDependencies {
	const dependencies = requireRecord(
		value,
		'plugin runtime startup dependencies must be an object'
	);
	assertAllowedKeys(dependencies, STARTUP_DEPENDENCY_KEYS, 'plugin runtime startup dependencies');
	if (!('productionOmp' in dependencies)) {
		throw new Error('plugin runtime startup dependencies require productionOmp');
	}
	assertCompleteProductionOmpIdentity(dependencies.productionOmp);
}

function assertCompleteProductionOmpIdentity(value: unknown): void {
	const configuration = requireRecord(value, 'productionOmp must be an object');
	assertAllowedKeys(
		configuration,
		PRODUCTION_OMP_CONFIGURATION_KEYS,
		'productionOmp configuration'
	);

	const pluginsDir = requireNonEmptyString(
		configuration,
		'pluginsDir',
		'complete production OMP identity'
	);
	const archivePath = requireNonEmptyString(
		configuration,
		'archivePath',
		'complete production OMP identity'
	);
	const archiveSha256 = requireNonEmptyString(
		configuration,
		'expectedArchiveSha256',
		'complete production OMP identity'
	);
	if (!isAbsolute(pluginsDir) || !isAbsolute(archivePath) || !SHA256_PATTERN.test(archiveSha256)) {
		throw new Error('productionOmp requires a complete production OMP identity');
	}

	const trustRoot = requireRecord(
		configuration.trustRoot,
		'productionOmp requires a complete production OMP identity'
	);
	assertAllowedKeys(trustRoot, TRUST_ROOT_KEYS, 'productionOmp trust root');
	if (
		requireNonEmptyString(trustRoot, 'keyId', 'complete production OMP identity') === '' ||
		requireNonEmptyString(trustRoot, 'algorithm', 'complete production OMP identity') !==
			'ed25519' ||
		requireNonEmptyString(trustRoot, 'publicKey', 'complete production OMP identity') === ''
	) {
		throw new Error('productionOmp requires a complete production OMP identity');
	}

	if (typeof configuration.verifySignature !== 'function') {
		throw new Error('productionOmp requires a complete production OMP identity');
	}
	assertPinnedRelease(configuration.pinnedRelease);
	assertRuntimeResolverIdentity(configuration);

	if (
		configuration.managedInstallOptIn !== undefined &&
		typeof configuration.managedInstallOptIn !== 'function'
	) {
		throw new Error('productionOmp managedInstallOptIn must be a function');
	}
}

function assertPinnedRelease(value: unknown): void {
	const pinnedRelease = requireRecord(
		value,
		'productionOmp requires a complete production OMP identity'
	);
	assertAllowedKeys(pinnedRelease, PINNED_RELEASE_KEYS, 'productionOmp pinned release');
	const npmKeyIds = pinnedRelease.npmKeyIds;
	if (
		requireNonEmptyString(pinnedRelease, 'packageName', 'complete production OMP identity') !==
			'@oh-my-pi/pi-coding-agent' ||
		requireNonEmptyString(pinnedRelease, 'version', 'complete production OMP identity') !==
			'16.4.8' ||
		requireNonEmptyString(pinnedRelease, 'registryOrigin', 'complete production OMP identity') !==
			'https://registry.npmjs.org' ||
		!Array.isArray(npmKeyIds) ||
		npmKeyIds.length === 0 ||
		npmKeyIds.some((keyId) => typeof keyId !== 'string' || keyId.trim() === '')
	) {
		throw new Error('productionOmp requires a complete production OMP identity');
	}
	if (pinnedRelease.system !== undefined) {
		const systemRelease = requireRecord(
			pinnedRelease.system,
			'productionOmp requires a complete production OMP identity'
		);
		assertAllowedKeys(
			systemRelease,
			PINNED_SYSTEM_RELEASE_KEYS,
			'productionOmp pinned system release'
		);
		requireNonEmptyString(systemRelease, 'publisher', 'complete production OMP identity');
		requireNonEmptyString(systemRelease, 'fingerprintSha512', 'complete production OMP identity');
	}
}

function assertRuntimeResolverIdentity(configuration: UnknownRecord): void {
	const hasResolver = configuration.resolver !== undefined;
	const hasResolverDependencies = configuration.runtimeResolverDependencies !== undefined;
	if (hasResolver === hasResolverDependencies) {
		throw new Error('productionOmp requires exactly one runtime resolver identity');
	}
	if (hasResolver) {
		const resolver = requireRecord(
			configuration.resolver,
			'productionOmp resolver must be an object'
		);
		for (const method of ['resolveSystem', 'managedInstallAllowed', 'resolveManaged']) {
			if (typeof resolver[method] !== 'function') {
				throw new Error(`productionOmp resolver requires ${method}`);
			}
		}
		return;
	}

	const resolverDependencies = requireRecord(
		configuration.runtimeResolverDependencies,
		'productionOmp runtime resolver dependencies must be an object'
	);
	if (typeof resolverDependencies.managedInstallOptIn !== 'function') {
		throw new Error('productionOmp runtime resolver dependencies require managedInstallOptIn');
	}
}

function requireRecord(value: unknown, message: string): UnknownRecord {
	if (!isRecord(value)) throw new Error(message);
	return value;
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(
	record: UnknownRecord,
	key: string,
	identityMessage: string
): string {
	const value = record[key];
	if (typeof value !== 'string' || value.trim() === '') {
		throw new Error(`productionOmp requires ${identityMessage}`);
	}
	return value;
}

function assertAllowedKeys(
	record: UnknownRecord,
	allowedKeys: Readonly<Record<string, true>>,
	label: string
): void {
	for (const key of Reflect.ownKeys(record)) {
		if (typeof key !== 'string' || !Object.hasOwn(allowedKeys, key)) {
			throw new Error(`${label} contains an unsupported property`);
		}
	}
}

function freezeRecursively(value: unknown, seen = new WeakSet<object>()): void {
	if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
	if (seen.has(value)) return;
	seen.add(value);

	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && 'value' in descriptor) freezeRecursively(descriptor.value, seen);
	}
	Object.freeze(value);
}
