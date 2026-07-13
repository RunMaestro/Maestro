import { createHash, timingSafeEqual } from 'crypto';

export const MANAGED_OMP_PACKAGE = '@oh-my-pi/pi-coding-agent';
export const MANAGED_OMP_VERSION = '16.4.8';

interface PackageManifest {
	name?: unknown;
	version?: unknown;
	bin?: unknown;
}

interface NpmSignature {
	keyid?: unknown;
	sig?: unknown;
}

interface NpmSubject {
	name?: unknown;
	digest?: { sha512?: unknown };
}

interface NpmAttestation {
	predicateType?: unknown;
	bundle?: {
		dsseEnvelope?: {
			payload?: unknown;
		};
	};
}

export interface NpmProvenanceDocument {
	integrity?: unknown;
	signatures?: unknown;
	attestations?: unknown;
}

export interface VerifiedProvenance {
	keyId: string;
	digest: string;
	attested: true;
}

export interface NpmSignatureVerifier {
	(keyId: string, signature: string, integrity: string): boolean;
}

export interface ManagedPackageInput {
	packageJson: string;
	tarball: Uint8Array;
	integrity: string;
}

export interface VerifiedManagedPackage {
	executable: string;
	version: typeof MANAGED_OMP_VERSION;
}

export function verifySha512Integrity(tarball: Uint8Array, integrity: string): string {
	const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
	if (!match) throw new Error('invalid sha512 integrity');

	const actual = createHash('sha512').update(tarball).digest();
	const expected = Buffer.from(match[1], 'base64');
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		throw new Error('sha512 integrity mismatch');
	}
	return match[1];
}

export function verifyManagedPackage(input: ManagedPackageInput): VerifiedManagedPackage {
	const manifest = parsePackageManifest(input.packageJson);
	if (manifest.name !== MANAGED_OMP_PACKAGE)
		throw new Error(`managed package must be ${MANAGED_OMP_PACKAGE}`);
	if (manifest.version !== MANAGED_OMP_VERSION)
		throw new Error('managed package version must be exactly 16.4.8');

	verifySha512Integrity(input.tarball, input.integrity);
	const executable = selectPackageExecutable(manifest.bin);
	return { executable, version: MANAGED_OMP_VERSION };
}

export function parseNpmProvenance(
	document: NpmProvenanceDocument,
	verifySignature?: NpmSignatureVerifier
): VerifiedProvenance {
	const integrity = document.integrity;
	const integrityMatch =
		typeof integrity === 'string' ? /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity) : null;
	if (!integrityMatch) throw new Error('invalid npm signature integrity evidence');
	const digest = integrityMatch[1];
	const signatures = Array.isArray(document.signatures) ? document.signatures : [];
	const validSignature = signatures
		.filter((entry): entry is NpmSignature => isRecord(entry))
		.find(
			(entry) =>
				typeof entry.keyid === 'string' &&
				entry.keyid.length > 0 &&
				typeof entry.sig === 'string' &&
				entry.sig.length > 0
		);
	if (!validSignature) throw new Error('missing npm signature evidence');

	if (
		verifySignature &&
		!verifySignature(
			validSignature.keyid as string,
			validSignature.sig as string,
			integrity as string
		)
	) {
		throw new Error('npm signature verification failed');
	}

	const attestations = Array.isArray(document.attestations) ? document.attestations : [];
	const hasMatchingAttestation = attestations
		.filter((entry): entry is NpmAttestation => isRecord(entry))
		.some((attestation) => {
			if (attestation.predicateType !== 'https://slsa.dev/provenance/v1') return false;
			const subject = parseDsseSubject(attestation.bundle?.dsseEnvelope?.payload);
			return (
				subject?.name === `pkg:npm/%40oh-my-pi/pi-coding-agent@${MANAGED_OMP_VERSION}` &&
				subject.digest?.sha512 === Buffer.from(digest, 'base64').toString('hex')
			);
		});
	if (!hasMatchingAttestation) throw new Error('missing matching npm attestation evidence');

	return { keyId: validSignature.keyid as string, digest, attested: true };
}

function parsePackageManifest(packageJson: string): PackageManifest {
	try {
		const parsed: unknown = JSON.parse(packageJson);
		if (!isRecord(parsed)) throw new Error('package manifest is not an object');
		return parsed;
	} catch {
		throw new Error('invalid package manifest');
	}
}

function selectPackageExecutable(bin: unknown): string {
	if (typeof bin === 'string') return validateExecutable(bin);
	if (!isRecord(bin)) throw new Error('managed package has no executable');
	const candidate = bin.omp;
	if (typeof candidate !== 'string') throw new Error('managed package has no omp executable');
	return validateExecutable(candidate);
}
function validateExecutable(candidate: string): string {
	if (
		candidate.length === 0 ||
		candidate.includes('\\') ||
		candidate.startsWith('/') ||
		candidate.split('/').some((part) => part === '..' || part.length === 0)
	) {
		throw new Error('unsafe package executable');
	}
	return candidate;
}

function parseDsseSubject(payload: unknown): NpmSubject | null {
	if (typeof payload !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null;
	try {
		const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
		if (!isRecord(decoded) || !Array.isArray(decoded.subject) || decoded.subject.length !== 1)
			return null;
		const subject = decoded.subject[0];
		if (!isRecord(subject) || typeof subject.name !== 'string' || !isRecord(subject.digest))
			return null;
		return {
			name: subject.name,
			digest: typeof subject.digest.sha512 === 'string' ? { sha512: subject.digest.sha512 } : {},
		};
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
