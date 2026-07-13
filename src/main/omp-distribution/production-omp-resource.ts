import { verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { ImmutableTrustRoot, PluginArtifactSignatureVerifier } from './plugin-artifact';
import type { PinnedOmpRelease } from './production-omp-runtime-resolver';

const BUNDLE_COMMIT = '1d627c2f';
const ARCHIVE_FILENAME = 'com.maestro.omp.omp';
const RELEASE_FILENAME = 'release.json';
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const SRI_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/=_-]{16,}$/;

/** Build-time authority. A release resource cannot substitute a signer of its choosing. */
export const COMPILED_OMP_RELEASE_TRUST_ROOT: ImmutableTrustRoot = Object.freeze({
	keyId: 'maestro-omp-release-root-2026-07',
	algorithm: 'ed25519',
	publicKey: 'MCowBQYDK2VwAyEAiO7gREXvBefL57LHQbNE8ZlgkDTvj5RpfmEg12nMDrs=',
});

export interface ProductionPinnedOmpRelease extends PinnedOmpRelease {
	readonly tarballUrl: string;
	readonly integrity: string;
	readonly npmSigners: readonly { readonly keyId: string; readonly publicKey: string }[];
	readonly files: {
		readonly count: number;
		readonly treeSha512: string;
		readonly executable: 'dist/cli.js';
	};
	readonly bundledRuntime: {
		readonly bunExecutable: string;
		readonly ompCliPath: string;
		readonly bunSha512: string;
		readonly ompCliSha512: string;
		readonly bunVersion: '1.3.14';
	};
	readonly provenance: {
		readonly repository: 'https://github.com/can1357/oh-my-pi';
		readonly workflow: '.github/workflows/ci.yml';
		readonly ref: 'refs/heads/main';
		readonly commit: string;
	};
}

export interface BundledOmpRuntimeResource {
	readonly bunExecutable: string;
	readonly ompCliPath: string;
	readonly bunSha512: string;
	readonly ompCliSha512: string;
	readonly bunVersion: '1.3.14';
}

export interface ProductionOmpResource {
	readonly archivePath: string;
	readonly expectedArchiveSha256: string;
	readonly publishedSignature: string;
	readonly trustRoot: ImmutableTrustRoot;
	readonly pinnedRelease: ProductionPinnedOmpRelease;
	readonly bundledRuntime: BundledOmpRuntimeResource;
	readonly verifySignature: PluginArtifactSignatureVerifier;
}
/**
 * Loads the two public resources copied by electron-builder. No private signing
 * material is ever read or embedded: artifact verification uses only the pinned
 * Ed25519 public root bundled with the signed release manifest.
 */
export function loadProductionOmpResource(resourceDirectory: string): ProductionOmpResource {
	if (isFixture(resourceDirectory)) throw new Error('fixture OMP production resource is forbidden');
	const directory = resolve(resourceDirectory);
	const archivePath = join(directory, ARCHIVE_FILENAME);
	const releasePath = join(directory, RELEASE_FILENAME);
	if (!existsSync(archivePath)) throw new Error('missing bundled OMP archive resource');
	if (!existsSync(releasePath)) throw new Error('missing OMP release resource');
	const release = parseRelease(readFileSync(releasePath, 'utf8'));
	if (
		!verify(
			null,
			Buffer.from(canonicalJson(release.unsigned)),
			{
				key: Buffer.from(COMPILED_OMP_RELEASE_TRUST_ROOT.publicKey, 'base64'),
				format: 'der',
				type: 'spki',
			},
			Buffer.from(release.releaseSignature, 'base64url')
		)
	) {
		throw new Error('OMP production release signature does not match the compiled trust anchor');
	}
	if (release.bundleCommit !== BUNDLE_COMMIT)
		throw new Error('OMP resource was not produced by the production packer');
	if (!SHA256_PATTERN.test(release.expectedArchiveSha256)) {
		throw new Error('OMP production resource has no published SHA-256');
	}
	if (!SIGNATURE_PATTERN.test(release.signature)) {
		throw new Error('OMP production resource has an invalid published signature');
	}
	const trustRoot = readTrustRoot(release.trustRoot);
	const pinnedRelease = readPinnedRelease(release.pinnedRelease);
	const bundledRuntime = resolveBundledRuntime(directory, pinnedRelease.bundledRuntime);
	const verifier = ed25519Verifier(trustRoot);
	return Object.freeze({
		archivePath,
		expectedArchiveSha256: release.expectedArchiveSha256.toLowerCase(),
		publishedSignature: release.signature,
		trustRoot,
		pinnedRelease,
		bundledRuntime,
		verifySignature: (
			payload: Uint8Array,
			signature: string,
			artifactTrustRoot: ImmutableTrustRoot
		) =>
			signature === release.signature &&
			sameTrustRoot(artifactTrustRoot, trustRoot) &&
			verifier(payload, signature, artifactTrustRoot),
	});
}

interface ValidatedRelease {
	readonly bundleCommit: string;
	readonly expectedArchiveSha256: string;
	readonly signature: string;
	readonly releaseSignature: string;
	readonly trustRoot: unknown;
	readonly pinnedRelease: unknown;
	readonly unsigned: Record<string, unknown>;
}

function parseRelease(content: string): ValidatedRelease {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error('OMP production release resource is invalid JSON');
	}
	if (!isRecord(parsed) || parsed.fixture === true || containsFixture(parsed)) {
		throw new Error('fixture OMP production resource is forbidden');
	}
	if (
		typeof parsed.bundleCommit !== 'string' ||
		typeof parsed.expectedArchiveSha256 !== 'string' ||
		typeof parsed.signature !== 'string' ||
		typeof parsed.releaseSignature !== 'string' ||
		!SIGNATURE_PATTERN.test(parsed.releaseSignature)
	) {
		throw new Error('OMP production release resource is incomplete');
	}
	const { releaseSignature: _releaseSignature, ...unsigned } = parsed;
	return {
		bundleCommit: parsed.bundleCommit,
		expectedArchiveSha256: parsed.expectedArchiveSha256,
		signature: parsed.signature,
		releaseSignature: parsed.releaseSignature,
		trustRoot: parsed.trustRoot,
		pinnedRelease: parsed.pinnedRelease,
		unsigned,
	};
}

function readTrustRoot(value: unknown): ImmutableTrustRoot {
	if (!isRecord(value) || value.algorithm !== 'ed25519') {
		throw new Error('OMP production trust root is invalid');
	}
	if (
		typeof value.keyId !== 'string' ||
		typeof value.publicKey !== 'string' ||
		value.keyId.trim() === '' ||
		value.publicKey.trim() === '' ||
		isFixture(value.keyId) ||
		isFixture(value.publicKey)
	) {
		throw new Error('OMP production trust root is invalid');
	}
	return Object.freeze({
		keyId: value.keyId,
		algorithm: value.algorithm,
		publicKey: value.publicKey,
	});
}

function readPinnedRelease(value: unknown): ProductionPinnedOmpRelease {
	if (
		!isRecord(value) ||
		!Array.isArray(value.npmSigners) ||
		!isRecord(value.files) ||
		!isRecord(value.bundledRuntime) ||
		!isRecord(value.provenance)
	) {
		throw new Error('OMP production release metadata is invalid');
	}
	if (
		value.packageName !== '@oh-my-pi/pi-coding-agent' ||
		value.version !== '16.4.8' ||
		value.registryOrigin !== 'https://registry.npmjs.org' ||
		value.tarballUrl !==
			'https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/-/pi-coding-agent-16.4.8.tgz' ||
		typeof value.integrity !== 'string' ||
		!SRI_PATTERN.test(value.integrity) ||
		value.npmSigners.length === 0 ||
		!value.npmSigners.every(
			(signer): signer is { keyId: string; publicKey: string } =>
				isRecord(signer) &&
				typeof signer.keyId === 'string' &&
				signer.keyId.trim() !== '' &&
				typeof signer.publicKey === 'string' &&
				signer.publicKey.trim() !== ''
		) ||
		value.files.count !== 2516 ||
		value.files.treeSha512 !== value.integrity ||
		value.files.executable !== 'dist/cli.js' ||
		!isSafeRelativePath(value.bundledRuntime.bunExecutable as string) ||
		!isSafeRelativePath(value.bundledRuntime.ompCliPath as string) ||
		typeof value.bundledRuntime.bunSha512 !== 'string' ||
		!SRI_PATTERN.test(value.bundledRuntime.bunSha512) ||
		typeof value.bundledRuntime.ompCliSha512 !== 'string' ||
		!SRI_PATTERN.test(value.bundledRuntime.ompCliSha512) ||
		value.bundledRuntime.bunVersion !== '1.3.14' ||
		value.provenance.repository !== 'https://github.com/can1357/oh-my-pi' ||
		value.provenance.workflow !== '.github/workflows/ci.yml' ||
		value.provenance.ref !== 'refs/heads/main' ||
		typeof value.provenance.commit !== 'string' ||
		!/^[a-f0-9]{40}$/i.test(value.provenance.commit)
	) {
		throw new Error('OMP production release metadata is invalid');
	}
	return Object.freeze({
		packageName: '@oh-my-pi/pi-coding-agent',
		version: '16.4.8',
		registryOrigin: 'https://registry.npmjs.org',
		npmKeyIds: Object.freeze(value.npmSigners.map((signer) => signer.keyId)),
		tarballUrl: value.tarballUrl,
		integrity: value.integrity,
		npmSigners: Object.freeze(value.npmSigners.map((signer) => Object.freeze({ ...signer }))),
		files: Object.freeze({
			count: 2516,
			treeSha512: value.integrity,
			executable: 'dist/cli.js' as const,
		}),
		bundledRuntime: Object.freeze({
			bunExecutable: value.bundledRuntime.bunExecutable as string,
			ompCliPath: value.bundledRuntime.ompCliPath as string,
			bunSha512: value.bundledRuntime.bunSha512 as string,
			ompCliSha512: value.bundledRuntime.ompCliSha512 as string,
			bunVersion: '1.3.14' as const,
		}),
		provenance: Object.freeze({
			repository: 'https://github.com/can1357/oh-my-pi' as const,
			workflow: '.github/workflows/ci.yml' as const,
			ref: 'refs/heads/main' as const,
			commit: value.provenance.commit,
		}),
	});
}

function ed25519Verifier(trustRoot: ImmutableTrustRoot): PluginArtifactSignatureVerifier {
	const key = Buffer.from(trustRoot.publicKey, 'base64');
	return (payload, signature) => {
		try {
			return verify(
				null,
				payload,
				{ key, format: 'der', type: 'spki' },
				Buffer.from(signature, 'base64url')
			);
		} catch {
			return false;
		}
	};
}

function sameTrustRoot(left: ImmutableTrustRoot, right: ImmutableTrustRoot): boolean {
	return (
		left.keyId === right.keyId &&
		left.algorithm === right.algorithm &&
		left.publicKey === right.publicKey
	);
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	return `{${Object.keys(value)
		.sort()
		.map(
			(key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
		)
		.join(',')}}`;
}

function resolveBundledRuntime(
	resourceDirectory: string,
	runtime: ProductionPinnedOmpRelease['bundledRuntime']
): BundledOmpRuntimeResource {
	const bunExecutable = resolve(resourceDirectory, runtime.bunExecutable);
	const ompCliPath = resolve(resourceDirectory, runtime.ompCliPath);
	if (
		!isSafeRelativePath(runtime.bunExecutable) ||
		!isSafeRelativePath(runtime.ompCliPath) ||
		!bunExecutable.startsWith(`${resourceDirectory}\\`) ||
		!ompCliPath.startsWith(`${resourceDirectory}\\`) ||
		!existsSync(bunExecutable) ||
		!existsSync(ompCliPath)
	) {
		throw new Error('OMP bundled runtime resource is unavailable');
	}
	return Object.freeze({
		bunExecutable,
		ompCliPath,
		bunSha512: runtime.bunSha512,
		ompCliSha512: runtime.ompCliSha512,
		bunVersion: runtime.bunVersion,
	});
}

function isSafeRelativePath(value: string): boolean {
	return (
		value.length > 0 &&
		!value.includes('\\') &&
		!value.startsWith('/') &&
		!value.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsFixture(value: unknown): boolean {
	if (typeof value === 'string') return isFixture(value);
	if (Array.isArray(value)) return value.some(containsFixture);
	return isRecord(value) && Object.values(value).some(containsFixture);
}

function isFixture(value: string): boolean {
	return value.toLowerCase().includes('fixture');
}
