import { createHash, verify } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REQUIRED_FILES = ['com.maestro.omp.omp', 'release.json'];
const SHA256 = /^[a-f0-9]{64}$/i;
const SIGNATURE = /^[A-Za-z0-9+/=_-]{16,}$/;

/** electron-builder beforePack hook: production OMP resources are public, pinned, and complete. */
export default function verifyOmpProductionResource() {
	const resourceDirectory = resolve(import.meta.dirname, '..', 'dist', 'omp-production');
	if (!existsSync(resourceDirectory))
		throw new Error('production OMP resource directory is missing');
	if (resourceDirectory.toLowerCase().includes('fixture')) {
		throw new Error('production OMP package cannot include fixture resources');
	}
	const files = readdirSync(resourceDirectory).sort();
	if (
		files.length !== REQUIRED_FILES.length ||
		files.some((file, index) => file !== REQUIRED_FILES[index])
	) {
		throw new Error(
			'production OMP resource directory must contain exactly the signed archive and release manifest'
		);
	}
	const archive = readFileSync(resolve(resourceDirectory, REQUIRED_FILES[0]));
	const release = parseRelease(readFileSync(resolve(resourceDirectory, REQUIRED_FILES[1]), 'utf8'));
	const sha256 = createHash('sha256').update(archive).digest('hex');
	if (sha256 !== release.expectedArchiveSha256.toLowerCase()) {
		throw new Error('production OMP archive SHA-256 differs from its immutable release manifest');
	}
	verifyArtifactSignature(archive, release);
	process.stdout.write(
		`${JSON.stringify({ files: files.length, archiveBytes: archive.length, sha256 })}\n`
	);
}

function parseRelease(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error('production OMP release manifest is invalid JSON');
	}
	if (!value || typeof value !== 'object' || Array.isArray(value) || containsFixture(value)) {
		throw new Error('production OMP release manifest rejects fixture inputs');
	}
	const { bundleCommit, expectedArchiveSha256, signature, trustRoot, pinnedRelease } = value;
	if (
		bundleCommit !== '1d627c2f' ||
		!SHA256.test(expectedArchiveSha256) ||
		!SIGNATURE.test(signature)
	) {
		throw new Error('production OMP release manifest has invalid immutable release inputs');
	}
	if (
		!trustRoot ||
		trustRoot.algorithm !== 'ed25519' ||
		typeof trustRoot.keyId !== 'string' ||
		!pinnedRelease ||
		pinnedRelease.packageName !== '@oh-my-pi/pi-coding-agent' ||
		pinnedRelease.version !== '16.4.8' ||
		pinnedRelease.registryOrigin !== 'https://registry.npmjs.org' ||
		!Array.isArray(pinnedRelease.npmKeyIds) ||
		pinnedRelease.npmKeyIds.length === 0 ||
		pinnedRelease.npmKeyIds.some((keyId) => typeof keyId !== 'string' || keyId.length === 0)
	) {
		throw new Error('production OMP release manifest has invalid trust metadata');
	}
	if (Object.keys(value).some((key) => /private|secret/i.test(key))) {
		throw new Error('production OMP release manifest must not embed a private key');
	}
	return value;
}

function verifyArtifactSignature(archive, release) {
	let artifact;
	try {
		artifact = JSON.parse(archive.toString('utf8'));
	} catch {
		throw new Error('production OMP archive is not a signed artifact');
	}
	if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
		throw new Error('production OMP archive is not a signed artifact');
	}
	const { signature, ...unsigned } = artifact;
	const artifactTrustRoot = unsigned.trustRoot;
	if (
		signature !== release.signature ||
		!artifactTrustRoot ||
		artifactTrustRoot.keyId !== release.trustRoot.keyId ||
		artifactTrustRoot.algorithm !== 'ed25519' ||
		artifactTrustRoot.publicKey !== release.trustRoot.publicKey
	) {
		throw new Error('production OMP archive does not match its immutable signature inputs');
	}
	try {
		const key = Buffer.from(release.trustRoot.publicKey, 'base64');
		if (
			!verify(
				null,
				Buffer.from(canonicalJson(unsigned)),
				{ key, format: 'der', type: 'spki' },
				Buffer.from(signature, 'base64url')
			)
		) {
			throw new Error('signature invalid');
		}
	} catch {
		throw new Error('production OMP artifact signature verification failed');
	}
}

function canonicalJson(value) {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
		.join(',')}}`;
}

function containsFixture(value) {
	if (typeof value === 'string') return value.toLowerCase().includes('fixture');
	if (Array.isArray(value)) return value.some(containsFixture);
	return value && typeof value === 'object' && Object.values(value).some(containsFixture);
}

if (import.meta.main) verifyOmpProductionResource();
