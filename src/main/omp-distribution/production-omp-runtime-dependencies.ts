import { createHash, timingSafeEqual } from 'node:crypto';
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';

import type { VerifiedRuntimeLaunch } from '../plugins/plugin-managed-runtime-service';
import type { BundledOmpRuntimeResource, ProductionOmpResource } from './production-omp-resource';
import type { ProductionOmpRuntimeResolverDependencies } from './production-omp-runtime-resolver';

export interface ProductionOmpRuntimeDependencyInput {
	readonly resource: ProductionOmpResource;
	/** Native host confirmation; it is called before any bundled fallback file is read. */
	readonly confirmBundledRuntime: () => Promise<boolean>;
}

export interface ProductionOmpRuntimeDependencies {
	readonly runtimeResolverDependencies: Omit<
		ProductionOmpRuntimeResolverDependencies,
		'pinnedRelease' | 'managedInstallOptIn'
	>;
	readonly managedInstallOptIn: () => boolean;
}

/**
 * Concrete packaged-runtime authority. The fallback is already bundled, signed by the
 * host release, and re-authenticated before every launch; no runtime network, shell,
 * npm, package-manager cache, or user-writable install root participates.
 */
export function createProductionOmpRuntimeDependencies(
	input: ProductionOmpRuntimeDependencyInput
): ProductionOmpRuntimeDependencies {
	const bundledRuntimeFallback = Object.freeze({
		resolve: async (): Promise<VerifiedRuntimeLaunch> => {
			if (!(await input.confirmBundledRuntime())) {
				throw new Error('bundled OMP runtime use was declined');
			}
			return authenticateBundledRuntime(input.resource.bundledRuntime);
		},
	});
	return Object.freeze({
		runtimeResolverDependencies: Object.freeze({ bundledRuntimeFallback }),
		managedInstallOptIn: () => true,
	});
}

async function authenticateBundledRuntime(
	runtime: BundledOmpRuntimeResource
): Promise<VerifiedRuntimeLaunch> {
	const [bunIdentity, ompCliIdentity] = await Promise.all([
		authenticateFile(runtime.bunExecutable, runtime.bunSha512),
		authenticateFile(runtime.ompCliPath, runtime.ompCliSha512),
	]);
	const revalidateForLaunch = async (): Promise<VerifiedRuntimeLaunch> => {
		const revalidated = await authenticateBundledRuntime(runtime);
		if (
			revalidated.fileIdentities[0]?.identity !== bunIdentity.identity ||
			revalidated.fileIdentities[1]?.identity !== ompCliIdentity.identity
		) {
			throw new Error('bundled OMP runtime bytes changed after authentication');
		}
		return revalidated;
	};
	return Object.freeze({
		executablePath: bunIdentity.canonicalPath,
		prefixArgs: Object.freeze([ompCliIdentity.canonicalPath]),
		fileIdentities: Object.freeze([bunIdentity, ompCliIdentity]),
		revalidateForLaunch,
		version: '16.4.8',
		provenance: 'verified',
	});
}

async function authenticateFile(path: string, expectedIdentity: string) {
	const canonicalPath = await realpath(path);
	if (canonicalPath !== path) throw new Error('bundled OMP runtime path is not canonical');
	const entry = await lstat(canonicalPath);
	if (
		!entry.isFile() ||
		entry.isSymbolicLink() ||
		(await hasWritableOrReparseAncestor(canonicalPath))
	) {
		throw new Error('bundled OMP runtime path is unsafe');
	}
	const contents = await readFile(canonicalPath);
	const identity = `sha512-${createHash('sha512').update(contents).digest('base64')}`;
	if (!sameSRI(identity, expectedIdentity)) throw new Error('bundled OMP runtime digest mismatch');
	return Object.freeze({ canonicalPath, identity });
}

function sameSRI(actual: string, expected: string): boolean {
	if (
		!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(actual) ||
		!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(expected)
	) {
		return false;
	}
	const actualBytes = Buffer.from(actual);
	const expectedBytes = Buffer.from(expected);
	return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

async function hasWritableOrReparseAncestor(filePath: string): Promise<boolean> {
	let current = filePath;
	for (;;) {
		const entry = await lstat(current);
		if (entry.isSymbolicLink()) return true;
		try {
			await access(current, constants.W_OK);
			return true;
		} catch {
			// Every component must be non-user-writable.
		}
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}
