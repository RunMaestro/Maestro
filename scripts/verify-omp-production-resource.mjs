import { createHash, verify } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REQUIRED_FILES = ['com.maestro.omp.omp', 'release.json'];
const REQUIRED_DIRECTORIES = ['bun', 'omp'];
const COMPILED_RELEASE_PUBLIC_KEY = 'MCowBQYDK2VwAyEAiO7gREXvBefL57LHQbNE8ZlgkDTvj5RpfmEg12nMDrs=';
const SHA256 = /^[a-f0-9]{64}$/i;
const SRI = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
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
		REQUIRED_FILES.some((file) => !files.includes(file)) ||
		REQUIRED_DIRECTORIES.some((directory) => !files.includes(directory))
	) {
		throw new Error(
			'production OMP resource directory is missing required signed runtime resources'
		);
	}
	const archive = readFileSync(resolve(resourceDirectory, REQUIRED_FILES[0]));
	const release = parseRelease(readFileSync(resolve(resourceDirectory, REQUIRED_FILES[1]), 'utf8'));
	verifyReleaseSignature(release);
	const sha256 = createHash('sha256').update(archive).digest('hex');
	if (sha256 !== release.expectedArchiveSha256.toLowerCase()) {
		throw new Error('production OMP archive SHA-256 differs from its immutable release manifest');
	}
	const bun = resolve(resourceDirectory, release.pinnedRelease.bundledRuntime.bunExecutable);
	const ompCli = resolve(resourceDirectory, release.pinnedRelease.bundledRuntime.ompCliPath);
	if (!existsSync(bun) || !existsSync(ompCli)) {
		throw new Error('production OMP bundled Bun or CLI resource is missing');
	}
	if (
		!sameSRI(readFileSync(bun), release.pinnedRelease.bundledRuntime.bunSha512) ||
		!sameSRI(readFileSync(ompCli), release.pinnedRelease.bundledRuntime.ompCliSha512)
	) {
		throw new Error('production OMP bundled runtime bytes differ from the signed release manifest');
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
	const {
		bundleCommit,
		expectedArchiveSha256,
		signature,
		releaseSignature,
		trustRoot,
		pinnedRelease,
	} = value;
	if (
		bundleCommit !== '1d627c2f' ||
		!SHA256.test(expectedArchiveSha256) ||
		!SIGNATURE.test(signature) ||
		!SIGNATURE.test(releaseSignature)
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
		pinnedRelease.tarballUrl !==
			'https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/-/pi-coding-agent-16.4.8.tgz' ||
		!SRI.test(pinnedRelease.integrity) ||
		!Array.isArray(pinnedRelease.npmSigners) ||
		pinnedRelease.npmSigners.length === 0 ||
		pinnedRelease.npmSigners.some(
			(signer) =>
				!signer || typeof signer.keyId !== 'string' || typeof signer.publicKey !== 'string'
		) ||
		!pinnedRelease.files ||
		pinnedRelease.files.count !== 2516 ||
		pinnedRelease.files.treeSha512 !== pinnedRelease.integrity ||
		pinnedRelease.files.executable !== 'dist/cli.js' ||
		!pinnedRelease.bundledRuntime ||
		!SRI.test(pinnedRelease.bundledRuntime.bunSha512) ||
		!SRI.test(pinnedRelease.bundledRuntime.ompCliSha512) ||
		pinnedRelease.bundledRuntime.bunVersion !== '1.3.14' ||
		!pinnedRelease.provenance ||
		pinnedRelease.provenance.repository !== 'https://github.com/can1357/oh-my-pi'
	) {
		throw new Error('production OMP release manifest has invalid trust metadata');
	}
	if (Object.keys(value).some((key) => /private|secret/i.test(key))) {
		throw new Error('production OMP release manifest must not embed a private key');
	}
	return value;
}

function verifyReleaseSignature(release) {
	const { releaseSignature, ...unsigned } = release;
	try {
		if (
			!verify(
				null,
				Buffer.from(canonicalJson(unsigned)),
				{ key: Buffer.from(COMPILED_RELEASE_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' },
				Buffer.from(releaseSignature, 'base64url')
			)
		) {
			throw new Error('signature invalid');
		}
	} catch {
		throw new Error('production OMP release signature does not match the compiled trust anchor');
	}
}

function sameSRI(bytes, expected) {
	const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
	return actual === expected;
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
