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
	integrity?: unknown;
}

interface NpmSubject {
	name?: unknown;
	digest?: { sha512?: unknown };
}

interface NpmAttestation {
	predicateType?: unknown;
	subject?: unknown;
}

export interface NpmProvenanceDocument {
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
	const signatures = Array.isArray(document.signatures) ? document.signatures : [];
	const validSignature = signatures
		.filter((entry): entry is NpmSignature => isRecord(entry))
		.find(
			(entry) =>
				typeof entry.keyid === 'string' &&
				entry.keyid.length > 0 &&
				typeof entry.sig === 'string' &&
				entry.sig.length > 0 &&
				typeof entry.integrity === 'string'
		);
	if (!validSignature) throw new Error('missing npm signature evidence');

	const integrityMatch = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(validSignature.integrity as string);
	if (!integrityMatch) throw new Error('invalid npm signature integrity evidence');
	const digest = integrityMatch[1];
	if (
		verifySignature &&
		!verifySignature(
			validSignature.keyid as string,
			validSignature.sig as string,
			validSignature.integrity as string
		)
	) {
		throw new Error('npm signature verification failed');
	}

	const attestations = Array.isArray(document.attestations) ? document.attestations : [];
	const hasMatchingAttestation = attestations
		.filter((entry): entry is NpmAttestation => isRecord(entry))
		.some((attestation) => {
			if (
				attestation.predicateType !== 'https://slsa.dev/provenance/v1' ||
				!Array.isArray(attestation.subject)
			)
				return false;
			return attestation.subject.some((subject) => {
				if (!isRecord(subject)) return false;
				const typedSubject = subject as NpmSubject;
				return typedSubject.name === MANAGED_OMP_PACKAGE && typedSubject.digest?.sha512 === digest;
			});
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
	const candidate = bin.pi;
	if (typeof candidate !== 'string') throw new Error('managed package has no pi executable');
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
