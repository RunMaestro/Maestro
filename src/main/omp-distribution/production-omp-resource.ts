import { verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { ImmutableTrustRoot, PluginArtifactSignatureVerifier } from './plugin-artifact';
import type { PinnedOmpRelease } from './production-omp-runtime-resolver';

const BUNDLE_COMMIT = '1d627c2f';
const ARCHIVE_FILENAME = 'com.maestro.omp.omp';
const RELEASE_FILENAME = 'release.json';
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/=_-]{16,}$/;

export interface ProductionOmpResource {
	readonly archivePath: string;
	readonly expectedArchiveSha256: string;
	readonly publishedSignature: string;
	readonly trustRoot: ImmutableTrustRoot;
	readonly pinnedRelease: PinnedOmpRelease;
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
	const verifier = ed25519Verifier(trustRoot);
	return Object.freeze({
		archivePath,
		expectedArchiveSha256: release.expectedArchiveSha256.toLowerCase(),
		publishedSignature: release.signature,
		trustRoot,
		pinnedRelease,
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
	readonly trustRoot: unknown;
	readonly pinnedRelease: unknown;
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
		typeof parsed.signature !== 'string'
	) {
		throw new Error('OMP production release resource is incomplete');
	}
	return {
		bundleCommit: parsed.bundleCommit,
		expectedArchiveSha256: parsed.expectedArchiveSha256,
		signature: parsed.signature,
		trustRoot: parsed.trustRoot,
		pinnedRelease: parsed.pinnedRelease,
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

function readPinnedRelease(value: unknown): PinnedOmpRelease {
	if (!isRecord(value) || !Array.isArray(value.npmKeyIds)) {
		throw new Error('OMP production release metadata is invalid');
	}
	if (
		value.packageName !== '@oh-my-pi/pi-coding-agent' ||
		value.version !== '16.4.8' ||
		value.registryOrigin !== 'https://registry.npmjs.org' ||
		!value.npmKeyIds.every(
			(keyId): keyId is string => typeof keyId === 'string' && keyId.trim() !== ''
		)
	) {
		throw new Error('OMP production release metadata is invalid');
	}
	return Object.freeze({
		packageName: '@oh-my-pi/pi-coding-agent',
		version: '16.4.8',
		registryOrigin: 'https://registry.npmjs.org',
		npmKeyIds: Object.freeze([...value.npmKeyIds]),
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
