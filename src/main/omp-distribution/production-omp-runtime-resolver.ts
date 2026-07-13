import { createHash, timingSafeEqual } from 'node:crypto';
import { access, lstat, realpath, readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { constants } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

import type {
	ManagedRuntimeResolver,
	VerifiedRuntimeLaunch,
} from '../plugins/plugin-managed-runtime-service';
import {
	MANAGED_OMP_PACKAGE,
	MANAGED_OMP_VERSION,
	type NpmProvenanceDocument,
	type NpmSignatureVerifier,
} from './integrity';
import {
	fetchVerifiedManagedPackage,
	type ManagedPackageFetcher,
	type ManagedPackageMetadata,
} from './managed-package-source';
import { nodeRuntimeFileSystem } from './node-runtime-fs';
import { installManagedRuntime, type RuntimeFileSystem } from './runtime-installer';

const DEFAULT_METADATA_MAX_BYTES = 1_048_576;
const DEFAULT_TARBALL_MAX_BYTES = 128 * 1_024 * 1_024;
const MAX_REDIRECTS = 2;

export interface PinnedOmpSystemRelease {
	readonly publisher: string;
	readonly fingerprintSha512: string;
}

/** Immutable production release facts supplied by the signed host build, never a settings value. */
export interface PinnedOmpRelease {
	readonly packageName: typeof MANAGED_OMP_PACKAGE;
	readonly version: typeof MANAGED_OMP_VERSION;
	readonly registryOrigin: string;
	readonly npmKeyIds: readonly string[];
	readonly system?: PinnedOmpSystemRelease;
}

/** An enrollment has no executable discovery semantics: its path is already canonical and explicitly chosen. */
export interface ConfiguredOmpEnrollment {
	readonly canonicalPath: string;
	readonly fingerprintSha512: string;
}

/** Verifies the immutable host enrollment record before the enrolled file is examined. */
export interface ConfiguredOmpEnrollmentVerifier {
	readonly verify: (enrollment: ConfiguredOmpEnrollment) => Promise<boolean>;
}

export interface SystemRuntimeCandidate {
	readonly path: string;
	readonly version: string;
	readonly publisher: string;
	readonly publisherProof: unknown;
}

export interface SystemRuntimePackageLocator {
	/** Returns package-manager/OS inventory candidates only. PATH is not an allowed source. */
	readonly locate: () => Promise<readonly SystemRuntimeCandidate[]>;
}

export interface ManagedRuntimePathInspection {
	readonly isRegularFile: boolean;
	readonly isReparsePoint: boolean;
	readonly isUserWritable: boolean;
	readonly fingerprintSha512: string;
}

/** Filesystem boundary for authentication. It never spawns or probes an executable. */
export interface ManagedRuntimePathInspector {
	readonly canonicalize: (path: string) => Promise<string>;
	readonly inspect: (canonicalPath: string) => Promise<ManagedRuntimePathInspection>;
}

export interface ProductionProvenanceVerifier {
	readonly verifySystemPublisherProof: (
		candidate: SystemRuntimeCandidate,
		release: PinnedOmpSystemRelease
	) => Promise<boolean>;
	readonly verifySlsaAttestation: (input: {
		readonly release: PinnedOmpRelease;
		readonly document: NpmProvenanceDocument;
		readonly sha512Digest: string;
	}) => Promise<boolean>;
}

export type RuntimeResolverDiagnostic =
	| 'none'
	| 'missing-trust-inputs'
	| 'system-candidate-rejected'
	| 'managed-install-disabled'
	| 'managed-package-rejected'
	| 'managed-install-failed';

/** Build-time bundled fallback resolver. It never downloads or extracts at runtime. */
export interface BundledOmpRuntimeFallback {
	readonly resolve: () => Promise<VerifiedRuntimeLaunch>;
}

export interface ProductionOmpRuntimeResolverDependencies {
	/** Absence is valid but leaves every discovery/install path fail-closed. */
	readonly pinnedRelease?: PinnedOmpRelease;
	readonly enrollment?: ConfiguredOmpEnrollment;
	readonly enrollmentVerifier?: ConfiguredOmpEnrollmentVerifier;
	readonly systemPackageLocator?: SystemRuntimePackageLocator;
	readonly pathInspector?: ManagedRuntimePathInspector;
	readonly provenanceVerifier?: ProductionProvenanceVerifier;
	readonly managedInstallOptIn: () => boolean;
	readonly bundledRuntimeFallback?: BundledOmpRuntimeFallback;
	readonly managedPackageFetcher?: ManagedPackageFetcher;
	readonly runtimeFileSystem?: RuntimeFileSystem;
	readonly managedRuntimeRoot?: string;
}

/** A bounded transport response. Bodies must already have been capped by the requester. */
export interface BoundedHttpsResponse {
	readonly statusCode: number;
	readonly headers: Readonly<Record<string, string | undefined>>;
	readonly body: Uint8Array;
}

export type BoundedHttpsRequester = (url: URL, maxBytes: number) => Promise<BoundedHttpsResponse>;

export interface BoundedNpmPackageFetcherInput {
	readonly registryOrigin: string;
	readonly metadataUrl: string;
	readonly provenanceUrl: string;
	readonly requester: BoundedHttpsRequester;
	readonly verifyNpmSignature: NpmSignatureVerifier;
	readonly maxMetadataBytes?: number;
	readonly maxTarballBytes?: number;
}

interface NpmPackageDocument {
	readonly name: string;
	readonly version: string;
	readonly bin: unknown;
	readonly dist: {
		readonly integrity: string;
		readonly tarball: string;
	};
	readonly signatures?: unknown;
}

interface ResolverManagedTrust {
	readonly release: PinnedOmpRelease;
	readonly fetcher: ManagedPackageFetcher;
	readonly fileSystem: RuntimeFileSystem;
	readonly root: string;
	readonly verifier: ProductionProvenanceVerifier;
}

/**
 * Production authority for host-owned OMP resolution. All candidates are authenticated from file bytes
 * and independent provenance records; this module intentionally contains no PATH lookup or child process call.
 */
export class ProductionOmpRuntimeResolver implements ManagedRuntimeResolver {
	private managedResolution: Promise<VerifiedRuntimeLaunch> | undefined;
	private lastDiagnostic: RuntimeResolverDiagnostic = 'none';

	constructor(private readonly deps: ProductionOmpRuntimeResolverDependencies) {}

	async resolveSystem(): Promise<VerifiedRuntimeLaunch | null> {
		const release = this.deps.pinnedRelease;
		const inspector = this.deps.pathInspector;
		if (!release || !inspector || !isValidRelease(release)) {
			this.lastDiagnostic = 'missing-trust-inputs';
			return null;
		}

		const enrolled = this.deps.enrollment;
		const enrollmentVerifier = this.deps.enrollmentVerifier;
		if (enrolled && enrollmentVerifier && isFrozenEnrollment(enrolled)) {
			const verified = await this.verifyConfiguredEnrollment(
				enrolled,
				enrollmentVerifier,
				inspector
			);
			if (verified) return verified;
		}

		const systemRelease = release.system;
		const locator = this.deps.systemPackageLocator;
		const verifier = this.deps.provenanceVerifier;
		if (!systemRelease || !isFrozenSystemRelease(systemRelease) || !locator || !verifier) {
			this.lastDiagnostic = 'missing-trust-inputs';
			return null;
		}

		try {
			for (const candidate of await locator.locate()) {
				const verified = await this.verifySystemCandidate(
					candidate,
					systemRelease,
					inspector,
					verifier
				);
				if (verified) return verified;
			}
		} catch {
			// An inventory/provider failure is indistinguishable from no trustworthy system runtime.
		}
		this.lastDiagnostic = 'system-candidate-rejected';
		return null;
	}

	managedInstallAllowed(): boolean {
		if (this.deps.bundledRuntimeFallback) {
			if (!safeOptIn(this.deps.managedInstallOptIn)) {
				this.lastDiagnostic = 'managed-install-disabled';
				return false;
			}
			return true;
		}
		const trust = this.managedTrust();
		if (!trust || !safeOptIn(this.deps.managedInstallOptIn)) {
			this.lastDiagnostic = trust ? 'managed-install-disabled' : 'missing-trust-inputs';
			return false;
		}
		return true;
	}

	async resolveManaged(): Promise<VerifiedRuntimeLaunch> {
		const bundled = this.deps.bundledRuntimeFallback;
		if (bundled) {
			if (!safeOptIn(this.deps.managedInstallOptIn)) {
				this.lastDiagnostic = 'managed-install-disabled';
				throw new Error('managed OMP runtime installation is disabled');
			}
			return bundled.resolve();
		}
		const trust = this.managedTrust();
		if (!trust) {
			this.lastDiagnostic = 'missing-trust-inputs';
			throw new Error('managed OMP runtime trust inputs are unavailable');
		}
		if (!safeOptIn(this.deps.managedInstallOptIn)) {
			this.lastDiagnostic = 'managed-install-disabled';
			throw new Error('managed OMP runtime installation is disabled');
		}
		this.managedResolution ??= this.resolveManagedOnce(trust).catch((error: unknown) => {
			this.managedResolution = undefined;
			throw error;
		});
		return this.managedResolution;
	}

	/** Call after the trusted release material is rotated or its local install is deliberately removed. */
	invalidate(): void {
		this.managedResolution = undefined;
		this.lastDiagnostic = 'none';
	}

	diagnostic(): RuntimeResolverDiagnostic {
		return this.lastDiagnostic;
	}

	private async verifyConfiguredEnrollment(
		enrollment: ConfiguredOmpEnrollment,
		verifier: ConfiguredOmpEnrollmentVerifier,
		inspector: ManagedRuntimePathInspector
	): Promise<VerifiedRuntimeLaunch | null> {
		try {
			if (!(await verifier.verify(enrollment))) return null;
			const canonicalPath = await inspector.canonicalize(enrollment.canonicalPath);
			if (canonicalPath !== enrollment.canonicalPath) return null;
			if (!(await isAuthenticatedFile(canonicalPath, enrollment.fingerprintSha512, inspector)))
				return null;
			return verifiedRuntime(canonicalPath, enrollment.fingerprintSha512, inspector);
		} catch {
			return null;
		}
	}

	private async verifySystemCandidate(
		candidate: SystemRuntimeCandidate,
		release: PinnedOmpSystemRelease,
		inspector: ManagedRuntimePathInspector,
		verifier: ProductionProvenanceVerifier
	): Promise<VerifiedRuntimeLaunch | null> {
		try {
			if (!isSystemCandidate(candidate) || candidate.version !== MANAGED_OMP_VERSION) return null;
			if (candidate.publisher !== release.publisher) return null;
			const canonicalPath = await inspector.canonicalize(candidate.path);
			if (canonicalPath !== candidate.path) return null;
			if (!(await isAuthenticatedFile(canonicalPath, release.fingerprintSha512, inspector)))
				return null;
			if (!(await verifier.verifySystemPublisherProof(candidate, release))) return null;
			return verifiedRuntime(canonicalPath, release.fingerprintSha512, inspector);
		} catch {
			return null;
		}
	}

	private managedTrust(): ResolverManagedTrust | null {
		const release = this.deps.pinnedRelease;
		const fetcher = this.deps.managedPackageFetcher;
		const verifier = this.deps.provenanceVerifier;
		const root = this.deps.managedRuntimeRoot;
		if (!release || !fetcher || !verifier || !root || !isAbsolute(root) || !isValidRelease(release))
			return null;
		return {
			release,
			fetcher: bindTrustedNpmSignatureVerifier(fetcher, release),
			fileSystem: this.deps.runtimeFileSystem ?? nodeRuntimeFileSystem,
			root,
			verifier,
		};
	}

	private async resolveManagedOnce(trust: ResolverManagedTrust): Promise<VerifiedRuntimeLaunch> {
		try {
			let provenanceDocument: NpmProvenanceDocument | undefined;
			const source = await fetchVerifiedManagedPackage({
				...trust.fetcher,
				fetchMetadata: async () => {
					const metadata = await trust.fetcher.fetchMetadata();
					provenanceDocument = metadata.provenance;
					return metadata;
				},
			});
			if (!provenanceDocument) throw new Error('managed OMP provenance document is unavailable');
			if (
				!(await trust.verifier.verifySlsaAttestation({
					release: trust.release,
					document: provenanceDocument,
					sha512Digest: source.provenance.digest,
				}))
			) {
				this.lastDiagnostic = 'managed-package-rejected';
				throw new Error('managed OMP SLSA attestation verification failed');
			}
			const installed = await installManagedRuntime(trust.fileSystem, trust.root, {
				version: source.version,
				executable: source.executable,
				files: source.files,
				notices: source.notices,
			});
			this.lastDiagnostic = 'none';
			return verifiedRuntime(
				installed.executable,
				source.provenance.digest,
				nodeManagedRuntimePathInspector
			);
		} catch (error) {
			if (this.lastDiagnostic === 'none') this.lastDiagnostic = 'managed-install-failed';
			throw error;
		}
	}
}

/** Factory used by startup wiring; callers must pass host-owned trust material explicitly. */
export function createProductionOmpRuntimeResolver(
	deps: ProductionOmpRuntimeResolverDependencies
): ProductionOmpRuntimeResolver {
	return new ProductionOmpRuntimeResolver(deps);
}

/**
 * Strict HTTPS registry adapter. Redirects are manually followed only when they remain at the pinned origin.
 * It never uses npm, a shell, a package manager cache, or an alternate download source.
 */
export function createBoundedNpmPackageFetcher(
	input: BoundedNpmPackageFetcherInput
): ManagedPackageFetcher {
	const registryOrigin = parseRegistryOrigin(input.registryOrigin);
	const metadataUrl = requireRegistryUrl(input.metadataUrl, registryOrigin);
	const provenanceUrl = requireRegistryUrl(input.provenanceUrl, registryOrigin);
	const maxMetadataBytes = input.maxMetadataBytes ?? DEFAULT_METADATA_MAX_BYTES;
	const maxTarballBytes = input.maxTarballBytes ?? DEFAULT_TARBALL_MAX_BYTES;
	assertPositiveBound(maxMetadataBytes);
	assertPositiveBound(maxTarballBytes);

	let metadataPromise: Promise<ManagedPackageMetadata> | undefined;
	let tarballUrl: URL | undefined;

	const fetchMetadata = async (): Promise<ManagedPackageMetadata> => {
		metadataPromise ??= (async () => {
			const metadata = parseNpmPackageDocument(
				await fetchJsonAtOrigin(input.requester, metadataUrl, registryOrigin, maxMetadataBytes)
			);
			if (metadata.name !== MANAGED_OMP_PACKAGE || metadata.version !== MANAGED_OMP_VERSION) {
				throw new Error('registry metadata does not identify the pinned managed OMP package');
			}
			tarballUrl = requireRegistryUrl(metadata.dist.tarball, registryOrigin);
			const provenance = parseProvenanceDocument(
				await fetchJsonAtOrigin(input.requester, provenanceUrl, registryOrigin, maxMetadataBytes)
			);
			return {
				packageJson: JSON.stringify({
					name: metadata.name,
					version: metadata.version,
					bin: metadata.bin,
				}),
				integrity: metadata.dist.integrity,
				provenance: {
					signatures: metadata.signatures,
					attestations: provenance.attestations,
				},
			};
		})();
		try {
			return await metadataPromise;
		} catch (error) {
			metadataPromise = undefined;
			tarballUrl = undefined;
			throw error;
		}
	};

	return {
		fetchMetadata,
		fetchTarball: async (): Promise<Uint8Array> => {
			await fetchMetadata();
			if (!tarballUrl) throw new Error('registry metadata omitted a tarball URL');
			return fetchBytesAtOrigin(input.requester, tarballUrl, registryOrigin, maxTarballBytes);
		},
		verifyNpmSignature: input.verifyNpmSignature,
	};
}

/** Node implementation that caps every response while it is streamed, before memory is unbounded. */
export const nodeBoundedHttpsRequester: BoundedHttpsRequester = (url, maxBytes) =>
	new Promise<BoundedHttpsResponse>((resolve, reject) => {
		const request = httpsRequest(
			url,
			{
				method: 'GET',
				headers: { accept: 'application/json, application/octet-stream;q=0.9' },
			},
			(response) => {
				const chunks: Buffer[] = [];
				let size = 0;
				response.on('data', (chunk: Buffer) => {
					size += chunk.length;
					if (size > maxBytes) {
						response.destroy(new Error('HTTPS response exceeds configured bound'));
						return;
					}
					chunks.push(Buffer.from(chunk));
				});
				response.once('error', reject);
				response.once('end', () => {
					resolve({
						statusCode: response.statusCode ?? 0,
						headers: normalizeHeaders(response.headers),
						body: Buffer.concat(chunks),
					});
				});
			}
		);
		request.once('error', reject);
		request.end();
	});

/** Node filesystem authentication adapter. A writable parent or reparse point is never trusted as system input. */
export const nodeManagedRuntimePathInspector: ManagedRuntimePathInspector = {
	canonicalize: realpath,
	async inspect(canonicalPath: string): Promise<ManagedRuntimePathInspection> {
		const entry = await lstat(canonicalPath);
		const unsafePath =
			entry.isSymbolicLink() || (await hasWritableOrReparseAncestor(canonicalPath));
		const contents = await readFile(canonicalPath);
		return {
			isRegularFile: entry.isFile(),
			isReparsePoint: unsafePath,
			isUserWritable: unsafePath,
			fingerprintSha512: `sha512-${createHash('sha512').update(contents).digest('base64')}`,
		};
	},
};

function bindTrustedNpmSignatureVerifier(
	fetcher: ManagedPackageFetcher,
	release: PinnedOmpRelease
): ManagedPackageFetcher {
	return {
		fetchMetadata: fetcher.fetchMetadata,
		fetchTarball: fetcher.fetchTarball,
		verifyNpmSignature: (keyId, signature, integrity) =>
			release.npmKeyIds.includes(keyId) && fetcher.verifyNpmSignature(keyId, signature, integrity),
	};
}

async function isAuthenticatedFile(
	canonicalPath: string,
	expectedFingerprint: string,
	inspector: ManagedRuntimePathInspector
): Promise<boolean> {
	if (!isAbsolute(canonicalPath) || !isSha512SRI(expectedFingerprint)) return false;
	const inspection = await inspector.inspect(canonicalPath);
	return (
		inspection.isRegularFile &&
		!inspection.isReparsePoint &&
		!inspection.isUserWritable &&
		constantTimeEqualSRI(inspection.fingerprintSha512, expectedFingerprint)
	);
}

function isValidRelease(release: PinnedOmpRelease): boolean {
	return (
		Object.isFrozen(release) &&
		release.packageName === MANAGED_OMP_PACKAGE &&
		release.version === MANAGED_OMP_VERSION &&
		isValidHttpsOrigin(release.registryOrigin) &&
		Object.isFrozen(release.npmKeyIds) &&
		release.npmKeyIds.length > 0 &&
		release.npmKeyIds.every((keyId) => typeof keyId === 'string' && keyId.length > 0)
	);
}

function isFrozenEnrollment(enrollment: ConfiguredOmpEnrollment): boolean {
	return (
		Object.isFrozen(enrollment) &&
		isAbsolute(enrollment.canonicalPath) &&
		isSha512SRI(enrollment.fingerprintSha512)
	);
}

function isFrozenSystemRelease(release: PinnedOmpSystemRelease): boolean {
	return (
		Object.isFrozen(release) &&
		typeof release.publisher === 'string' &&
		release.publisher.length > 0 &&
		isSha512SRI(release.fingerprintSha512)
	);
}

function isSystemCandidate(candidate: SystemRuntimeCandidate): boolean {
	return (
		candidate !== null &&
		typeof candidate === 'object' &&
		isAbsolute(candidate.path) &&
		typeof candidate.publisher === 'string' &&
		candidate.publisher.length > 0 &&
		candidate.publisherProof !== null &&
		candidate.publisherProof !== undefined
	);
}

function verifiedRuntime(
	executablePath: string,
	identity: string,
	inspector: ManagedRuntimePathInspector
): VerifiedRuntimeLaunch {
	const revalidateForLaunch = async (): Promise<VerifiedRuntimeLaunch> => {
		const canonicalPath = await inspector.canonicalize(executablePath);
		if (
			canonicalPath !== executablePath ||
			!(await isAuthenticatedFile(canonicalPath, identity, inspector))
		) {
			throw new Error('OMP runtime bytes changed after authentication');
		}
		return verifiedRuntime(executablePath, identity, inspector);
	};
	return Object.freeze({
		executablePath,
		prefixArgs: Object.freeze([]),
		fileIdentities: Object.freeze([Object.freeze({ canonicalPath: executablePath, identity })]),
		revalidateForLaunch,
		provenance: 'verified',
		version: MANAGED_OMP_VERSION,
	});
}

function safeOptIn(readOptIn: () => boolean): boolean {
	try {
		return readOptIn() === true;
	} catch {
		return false;
	}
}

function parseRegistryOrigin(value: string): URL {
	if (!isValidHttpsOrigin(value)) throw new Error('registry origin must be an exact HTTPS origin');
	return new URL(value);
}

function isValidHttpsOrigin(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === 'https:' && url.pathname === '/' && url.search === '' && url.hash === ''
		);
	} catch {
		return false;
	}
}

function requireRegistryUrl(value: string, origin: URL): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error('registry URL is invalid');
	}
	if (url.protocol !== 'https:' || url.origin !== origin.origin) {
		throw new Error('registry URL origin is not pinned');
	}
	return url;
}

async function fetchJsonAtOrigin(
	request: BoundedHttpsRequester,
	url: URL,
	origin: URL,
	maxBytes: number
): Promise<unknown> {
	const bytes = await fetchBytesAtOrigin(request, url, origin, maxBytes);
	try {
		return JSON.parse(Buffer.from(bytes).toString('utf8'));
	} catch {
		throw new Error('registry response is not valid JSON');
	}
}

async function fetchBytesAtOrigin(
	request: BoundedHttpsRequester,
	initialUrl: URL,
	origin: URL,
	maxBytes: number
): Promise<Uint8Array> {
	let current = initialUrl;
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
		const response = await request(current, maxBytes);
		if (response.body.byteLength > maxBytes)
			throw new Error('HTTPS response exceeds configured bound');
		if (response.statusCode >= 300 && response.statusCode < 400) {
			const location = response.headers.location;
			if (!location) throw new Error('registry redirect has no location');
			if (redirects === MAX_REDIRECTS) throw new Error('registry redirect limit exceeded');
			try {
				current = requireRegistryUrl(new URL(location, current).toString(), origin);
			} catch {
				throw new Error('registry redirect origin is not pinned');
			}
			continue;
		}
		if (response.statusCode !== 200)
			throw new Error(`registry request failed with status ${response.statusCode}`);
		return response.body;
	}
	throw new Error('registry redirect limit exceeded');
}

function parseNpmPackageDocument(value: unknown): NpmPackageDocument {
	if (!isRecord(value) || !isRecord(value.dist))
		throw new Error('registry package metadata is malformed');
	if (
		typeof value.name !== 'string' ||
		typeof value.version !== 'string' ||
		typeof value.dist.integrity !== 'string' ||
		typeof value.dist.tarball !== 'string'
	) {
		throw new Error('registry package metadata is malformed');
	}
	return {
		name: value.name,
		version: value.version,
		bin: value.bin,
		dist: { integrity: value.dist.integrity, tarball: value.dist.tarball },
		signatures: value.signatures,
	};
}

function parseProvenanceDocument(value: unknown): NpmProvenanceDocument {
	if (!isRecord(value) || !Array.isArray(value.attestations)) {
		throw new Error('registry provenance response is malformed');
	}
	return { attestations: value.attestations };
}

function assertPositiveBound(value: number): void {
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new Error('HTTPS response bound is invalid');
}

function normalizeHeaders(
	headers: Record<string, string | string[] | undefined>
): Record<string, string | undefined> {
	return Object.fromEntries(
		Object.entries(headers).map(([name, value]) => [
			name.toLowerCase(),
			Array.isArray(value) ? value[0] : value,
		])
	);
}

function isSha512SRI(value: string): boolean {
	return /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function constantTimeEqualSRI(left: string, right: string): boolean {
	if (!isSha512SRI(left) || !isSha512SRI(right)) return false;
	const actual = Buffer.from(left);
	const expected = Buffer.from(right);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
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
			// A non-writable component is required at every path level.
		}
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
