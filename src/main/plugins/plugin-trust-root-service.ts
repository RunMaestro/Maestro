import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import semver from 'semver';
import { isHostApiCompatible, HOST_API_VERSION } from '../../shared/plugins/host-api';
import { validatePluginManifest, type PluginManifest } from '../../shared/plugins/plugin-manifest';
import type { PermissionRequest } from '../../shared/plugins/permissions';
import {
	createVerifiedPluginArtifactSnapshot,
	parsePluginArtifact,
	PLUGIN_ARTIFACT_LIMITS,
	verifySignedPluginArtifact,
	type ImmutableTrustRoot,
	type ParsedPluginArtifact,
	type PluginArtifactSignatureVerifier,
	type VerifiedPluginArtifactSnapshot,
} from '../omp-distribution/plugin-artifact';

export const OMP_PLUGIN_ID = 'com.maestro.omp';
const INSTALL_STATE_FILENAME = '.maestro-omp-install.json';

type InstallOwner = 'bundle' | 'external';

interface ManagedInstallState {
	pluginId: typeof OMP_PLUGIN_ID;
	version: string;
	artifactSha256: string;
	/** The prior signed artifact is re-verified before it informs an upgrade decision. */
	artifactBase64: string;
	trustRootFingerprint: string;
}

export interface CapabilityDelta {
	added: readonly PermissionRequest[];
}

export interface OmpArchiveInstallRequest {
	archivePath: string;
	/** SHA-256 published alongside the packaged archive. This is never inferred from settings. */
	expectedSha256: string;
	/** Distinguishes bundled bootstrap policy from explicit external installation. */
	owner: InstallOwner;
	requestCapabilityConsent?: (delta: CapabilityDelta) => boolean;
}

export interface OmpArchiveInstallResult {
	action: 'installed' | 'updated' | 'unchanged' | 'preserved';
	manifest: PluginManifest;
	artifactSha256: string;
}

export interface OmpPluginTrustRootServiceDeps {
	pluginsDir: string;
	/** Compiled, security-reviewed signer metadata. There is deliberately no settings fallback. */
	trustRoot: ImmutableTrustRoot;
	/** The algorithm-specific verifier paired with the compiled trust root. */
	verifySignature: PluginArtifactSignatureVerifier;
	/** Test seam for proving rollback if promotion fails. */
	renameSync?: (oldPath: string, newPath: string) => void;
}

/**
 * Installs the first-party OMP artifact only after verifying its immutable signer,
 * canonical signature, published digest, archive paths, manifest, and host API.
 *
 * This service intentionally has no default trust root. Production wiring must
 * provide security-approved, compiled signer metadata; mutable settings cannot
 * establish a root of trust.
 */
export class OmpPluginTrustRootService {
	private readonly trustRoot: ImmutableTrustRoot;
	private readonly trustRootFingerprint: string;
	private activeSnapshot: VerifiedPluginArtifactSnapshot | null = null;
	private readonly renameSync: (oldPath: string, newPath: string) => void;

	constructor(private readonly deps: OmpPluginTrustRootServiceDeps) {
		assertImmutableTrustRoot(deps.trustRoot);
		this.trustRoot = Object.freeze({ ...deps.trustRoot });
		this.trustRootFingerprint = canonicalTrustRoot(this.trustRoot);
		this.renameSync = deps.renameSync ?? fs.renameSync;
	}

	bootstrapBundledArchive(
		request: Omit<OmpArchiveInstallRequest, 'owner'>
	): OmpArchiveInstallResult {
		return this.installOrUpdateArchive({ ...request, owner: 'bundle' });
	}

	getActiveSnapshot(): VerifiedPluginArtifactSnapshot | null {
		return this.activeSnapshot;
	}

	installOrUpdateArchive(request: OmpArchiveInstallRequest): OmpArchiveInstallResult {
		const archive = readBoundedArchive(request.archivePath);
		const artifactSha256 = sha256(archive);
		if (
			!isSha256(request.expectedSha256) ||
			artifactSha256 !== request.expectedSha256.toLowerCase()
		) {
			throw new Error('OMP archive digest verification failed');
		}

		let parsed: ParsedPluginArtifact;
		try {
			parsed = parsePluginArtifact(archive, this.trustRoot);
		} catch (error) {
			if (error instanceof Error && error.message === 'unsafe plugin artifact path') {
				throw new Error('unsafe OMP archive entry');
			}
			throw error;
		}
		assertSafeArtifactFiles(parsed);
		const artifact = verifySignedPluginArtifact(archive, this.trustRoot, this.deps.verifySignature);
		const snapshot = createVerifiedPluginArtifactSnapshot(artifact, archive);
		const manifest = validateArtifactManifest(artifact);
		const destination = path.join(this.deps.pluginsDir, OMP_PLUGIN_ID);
		const statePath = path.join(path.dirname(this.deps.pluginsDir), INSTALL_STATE_FILENAME);
		const state = readManagedState(statePath, this.trustRootFingerprint);
		const destinationExists = fs.existsSync(destination);

		if (destinationExists && !state) {
			throw new Error('existing OMP installation is not managed by the immutable OMP trust root');
		}
		if (!destinationExists && state) {
			throw new Error('OMP install state exists without its managed plugin directory');
		}
		if (!state) {
			this.promote(
				destination,
				statePath,
				artifact,
				managedState(manifest, archive, artifactSha256, this.trustRootFingerprint)
			);
			this.activateSnapshot(snapshot);
			return { action: 'installed', manifest, artifactSha256 };
		}

		const previousArchive = decodeStoredArtifact(state);
		const previousArtifact = verifySignedPluginArtifact(
			previousArchive,
			this.trustRoot,
			this.deps.verifySignature
		);
		assertSafeArtifactFiles(previousArtifact);
		const previousManifest = validateArtifactManifest(previousArtifact);
		if (previousManifest.version !== state.version) {
			throw new Error('managed OMP installation does not match its verified install state');
		}
		if (contentHashForDirectory(destination) !== contentHashForArtifact(previousArtifact)) {
			if (artifactSha256 !== state.artifactSha256) {
				throw new Error('managed OMP installation bytes do not match its verified signed artifact');
			}
			this.promote(
				destination,
				statePath,
				artifact,
				managedState(manifest, archive, artifactSha256, this.trustRootFingerprint)
			);
			this.activateSnapshot(snapshot);
			return { action: 'updated', manifest, artifactSha256 };
		}
		if (artifactSha256 === state.artifactSha256) {
			this.activateSnapshot(snapshot);
			return { action: 'unchanged', manifest, artifactSha256 };
		}
		if (!semver.valid(manifest.version) || !semver.valid(state.version)) {
			throw new Error('OMP install state contains an invalid version');
		}
		if (semver.lt(manifest.version, state.version)) {
			snapshot.release();
			if (request.owner === 'bundle') {
				this.activateSnapshot(
					createVerifiedPluginArtifactSnapshot(previousArtifact, previousArchive)
				);
				return preserved(manifest, artifactSha256);
			}
			throw new Error('OMP archive downgrade refused');
		}
		if (semver.eq(manifest.version, state.version))
			throw new Error('OMP archive equivocation detected');

		const added = capabilityDelta(previousManifest.permissions ?? [], manifest.permissions ?? []);
		if (added.length > 0 && !request.requestCapabilityConsent?.({ added })) {
			throw new Error('OMP capability delta requires explicit consent');
		}
		this.promote(
			destination,
			statePath,
			artifact,
			managedState(manifest, archive, artifactSha256, this.trustRootFingerprint)
		);
		this.activateSnapshot(snapshot);
		return { action: 'updated', manifest, artifactSha256 };
	}

	private promote(
		destination: string,
		statePath: string,
		artifact: ParsedPluginArtifact,
		nextState: ManagedInstallState
	): void {
		fs.mkdirSync(this.deps.pluginsDir, { recursive: true });
		fs.mkdirSync(path.dirname(statePath), { recursive: true });
		const staging = fs.mkdtempSync(path.join(this.deps.pluginsDir, '.omp-stage-'));
		const stagedPlugin = path.join(staging, OMP_PLUGIN_ID);
		const stagedState = path.join(staging, INSTALL_STATE_FILENAME);
		const backup = path.join(staging, `${OMP_PLUGIN_ID}.old`);
		const stateTemp = path.join(
			path.dirname(statePath),
			`.${INSTALL_STATE_FILENAME}.${process.pid}.${Date.now()}`
		);
		const hadDestination = fs.existsSync(destination);
		const previousState = readFileIfExists(statePath);
		let movedOld = false;
		let promoted = false;
		let replacedState = false;
		try {
			materializeArtifact(stagedPlugin, artifact);
			fs.writeFileSync(stagedState, `${JSON.stringify(nextState)}\n`, {
				encoding: 'utf8',
				flag: 'wx',
			});
			if (hadDestination) {
				this.renameSync(destination, backup);
				movedOld = true;
			}
			this.renameSync(stagedPlugin, destination);
			promoted = true;
			fs.copyFileSync(stagedState, stateTemp, fs.constants.COPYFILE_EXCL);
			this.renameSync(stateTemp, statePath);
			replacedState = true;
		} catch (error) {
			try {
				if (replacedState) restoreFile(statePath, previousState);
				if (promoted) fs.rmSync(destination, { recursive: true, force: true });
				if (movedOld) this.renameSync(backup, destination);
			} catch {
				throw new Error('OMP archive promotion failed and rollback could not be completed');
			}
			throw error;
		} finally {
			fs.rmSync(stateTemp, { force: true });
			fs.rmSync(staging, { recursive: true, force: true });
		}
	}

	private activateSnapshot(snapshot: VerifiedPluginArtifactSnapshot): void {
		this.activeSnapshot?.release();
		this.activeSnapshot = snapshot;
	}
}

function validateArtifactManifest(artifact: ParsedPluginArtifact): PluginManifest {
	if (artifact.pluginId !== OMP_PLUGIN_ID) throw new Error('unexpected first-party plugin id');
	const manifestFile = artifact.files.find((file) => file.path === 'plugin.json');
	if (!manifestFile) throw new Error('OMP artifact is missing plugin.json');
	let rawManifest: unknown;
	try {
		rawManifest = JSON.parse(decodeArtifactFile(manifestFile.content).toString('utf8'));
	} catch {
		throw new Error('OMP artifact plugin.json is invalid JSON');
	}
	const { manifest, errors } = validatePluginManifest(rawManifest);

	if (!manifest) throw new Error(`invalid OMP plugin.json: ${errors.join('; ')}`);
	if (manifest.id !== OMP_PLUGIN_ID || manifest.version !== artifact.version) {
		throw new Error('OMP artifact identity does not match plugin.json');
	}
	const compatibility = isHostApiCompatible(manifest.maestro.minHostApi, HOST_API_VERSION);
	if (!compatibility.compatible)
		throw new Error(`OMP host compatibility failed: ${compatibility.reason}`);
	return manifest;
}

function assertSafeArtifactFiles(artifact: ParsedPluginArtifact): void {
	const paths = new Set<string>();
	for (const file of artifact.files) {
		if (
			file.path.length === 0 ||
			file.path.startsWith('/') ||
			file.path.includes('\\') ||
			file.path.split('/').some((part) => part.length === 0 || part === '.' || part === '..') ||
			!paths.add(file.path)
		) {
			throw new Error('unsafe OMP archive entry');
		}
		decodeArtifactFile(file.content);
	}
}

function materializeArtifact(destination: string, artifact: ParsedPluginArtifact): void {
	fs.mkdirSync(destination, { recursive: true });
	for (const file of artifact.files) {
		const target = path.join(destination, ...file.path.split('/'));
		const resolved = path.resolve(target);
		if (!resolved.startsWith(`${path.resolve(destination)}${path.sep}`)) {
			throw new Error('unsafe OMP archive entry');
		}
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, decodeArtifactFile(file.content), { flag: 'wx' });
	}
}

function readManagedState(
	statePath: string,
	trustRootFingerprint: string
): ManagedInstallState | null {
	const content = readFileIfExists(statePath);
	if (content === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error('OMP install state is invalid');
	}
	if (!isManagedState(parsed) || parsed.trustRootFingerprint !== trustRootFingerprint) {
		throw new Error('OMP install state is not bound to the immutable trust root');
	}
	return parsed;
}

function decodeStoredArtifact(state: ManagedInstallState): Buffer {
	const archive = decodeArtifactFile(state.artifactBase64);
	if (sha256(archive) !== state.artifactSha256) {
		throw new Error('OMP install state does not contain its claimed signed artifact');
	}
	return archive;
}

function contentHashForArtifact(artifact: ParsedPluginArtifact): string {
	const hash = createHash('sha256');
	for (const file of [...artifact.files].sort((left, right) =>
		left.path.localeCompare(right.path)
	)) {
		hash.update(file.path);
		hash.update('\0');
		hash.update(decodeArtifactFile(file.content));
	}
	return hash.digest('hex');
}

function contentHashForDirectory(directory: string): string {
	const files: string[] = [];
	const visit = (current: string): void => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const absolute = path.join(current, entry.name);
			if (entry.isSymbolicLink()) throw new Error('managed OMP installation contains a symlink');
			if (entry.isDirectory()) {
				visit(absolute);
				continue;
			}
			if (!entry.isFile())
				throw new Error('managed OMP installation contains an unsupported entry');
			files.push(path.relative(directory, absolute).split(path.sep).join('/'));
		}
	};
	visit(directory);
	const hash = createHash('sha256');
	for (const relativePath of files.sort((left, right) => left.localeCompare(right))) {
		hash.update(relativePath);
		hash.update('\0');
		hash.update(fs.readFileSync(path.join(directory, ...relativePath.split('/'))));
	}
	return hash.digest('hex');
}

function capabilityDelta(
	previous: readonly PermissionRequest[],
	next: readonly PermissionRequest[]
): PermissionRequest[] {
	const previousKeys = new Set(previous.map(permissionKey));
	return next.filter((permission) => !previousKeys.has(permissionKey(permission)));
}

function permissionKey(permission: PermissionRequest): string {
	return `${permission.capability}\0${permission.scope ?? ''}`;
}

function managedState(
	manifest: PluginManifest,
	archive: Buffer,
	artifactSha256: string,
	trustRootFingerprint: string
): ManagedInstallState {
	return {
		pluginId: OMP_PLUGIN_ID,
		version: manifest.version,
		artifactSha256,
		artifactBase64: archive.toString('base64'),
		trustRootFingerprint,
	};
}

function preserved(manifest: PluginManifest, artifactSha256: string): OmpArchiveInstallResult {
	return { action: 'preserved', manifest, artifactSha256 };
}

function assertImmutableTrustRoot(trustRoot: ImmutableTrustRoot): void {
	if (!Object.isFrozen(trustRoot))
		throw new Error('OMP trust root must be immutable compiled metadata');
	if (
		trustRoot.keyId.trim() === '' ||
		trustRoot.algorithm.trim() === '' ||
		trustRoot.publicKey.trim() === ''
	) {
		throw new Error('OMP trust root is incomplete');
	}
}

function canonicalTrustRoot(trustRoot: ImmutableTrustRoot): string {
	return `${trustRoot.keyId}\0${trustRoot.algorithm}\0${trustRoot.publicKey}`;
}

function decodeArtifactFile(content: string): Buffer {
	const decoded = Buffer.from(content, 'base64');
	if (decoded.toString('base64') !== content) throw new Error('invalid OMP archive file encoding');
	return decoded;
}

function readBoundedArchive(archivePath: string): Buffer {
	const resolvedPath = path.resolve(archivePath);
	const preflight = fs.statSync(resolvedPath);
	if (!preflight.isFile()) throw new Error('OMP archive is not a regular file');
	if (preflight.size > PLUGIN_ARTIFACT_LIMITS.maxArtifactBytes) {
		throw new Error('OMP archive exceeds byte limit');
	}

	const descriptor = fs.openSync(resolvedPath, 'r');
	try {
		const opened = fs.fstatSync(descriptor);
		if (!opened.isFile()) throw new Error('OMP archive is not a regular file');
		if (opened.size > PLUGIN_ARTIFACT_LIMITS.maxArtifactBytes) {
			throw new Error('OMP archive exceeds byte limit');
		}
		const archive = Buffer.allocUnsafe(opened.size);
		let offset = 0;
		while (offset < archive.byteLength) {
			const read = fs.readSync(descriptor, archive, offset, archive.byteLength - offset, null);
			if (read === 0) throw new Error('OMP archive changed while reading');
			offset += read;
		}
		const overflow = Buffer.allocUnsafe(1);
		if (fs.readSync(descriptor, overflow, 0, overflow.byteLength, null) > 0) {
			throw new Error('OMP archive exceeds byte limit');
		}
		return archive;
	} finally {
		fs.closeSync(descriptor);
	}
}

function sha256(value: Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

function isSha256(value: string): boolean {
	return /^[a-f0-9]{64}$/i.test(value);
}

function readFileIfExists(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

function restoreFile(filePath: string, previous: string | null): void {
	if (previous === null) fs.rmSync(filePath, { force: true });
	else fs.writeFileSync(filePath, previous, 'utf8');
}

function isManagedState(value: unknown): value is ManagedInstallState {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const state = value as Partial<ManagedInstallState>;
	return (
		state.pluginId === OMP_PLUGIN_ID &&
		typeof state.version === 'string' &&
		isSha256(state.artifactSha256 ?? '') &&
		typeof state.artifactBase64 === 'string' &&
		typeof state.trustRootFingerprint === 'string'
	);
}
