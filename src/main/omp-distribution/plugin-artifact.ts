import { createHash } from 'crypto';
import {
	buildPluginContentHashPayload,
	isExcludedSignaturePath,
	SIGNATURE_FILENAME,
} from '../../shared/plugins/signing';

/** Hard caps keep hostile archives bounded before JSON parsing, decoding, or signature work. */
export const PLUGIN_ARTIFACT_LIMITS = Object.freeze({
	maxArtifactBytes: 16 * 1024 * 1024,
	maxFiles: 128,
	maxFileBytes: 2 * 1024 * 1024,
	maxDecodedBytes: 8 * 1024 * 1024,
	maxEncodedFileBytes: Math.ceil((2 * 1024 * 1024) / 3) * 4,
	maxPathLength: 240,
	maxPathDepth: 16,
});

export interface ImmutableTrustRoot {
	keyId: string;
	algorithm: string;
	publicKey: string;
}

export interface PluginArtifactFile {
	path: string;
	content: Uint8Array;
}

export interface PluginArtifactInput {
	pluginId: string;
	version: string;
	contractSha256: string;
	trustRoot: ImmutableTrustRoot;
	files: readonly PluginArtifactFile[];
	sign(payload: Uint8Array): string;
}

export interface PluginArtifactSignatureVerifier {
	(payload: Uint8Array, signature: string, trustRoot: ImmutableTrustRoot): boolean;
}

export interface ParsedPluginArtifact {
	schemaVersion: 1;
	pluginId: string;
	version: string;
	contractSha256: string;
	trustRoot: ImmutableTrustRoot;
	files: readonly { path: string; content: string }[];
	signature: string;
}

export interface PluginArtifactState {
	pluginId: string;
	version: string;
	contractSha256: string;
	artifactSha256: string;
}

/** Immutable identity that an activation and its grants bind to. */
export interface VerifiedPluginArtifactIdentity {
	pluginId: string;
	version: string;
	contractSha256: string;
	artifactSha256: string;
	authorizationContentHash: string;
	signerKeyId: string;
}

/**
 * Bounded execution/resource bytes copied from a verified artifact. The only
 * data exposed to runtime consumers is immutable text, never an installed path
 * or mutable Buffer reference.
 */
export class VerifiedPluginArtifactSnapshot {
	readonly identity: Readonly<VerifiedPluginArtifactIdentity>;
	private readonly textByPath: Map<string, string>;
	private storedByteLength: number;

	constructor(artifact: ParsedPluginArtifact, sourceArtifact: Uint8Array) {
		if (sourceArtifact.byteLength > PLUGIN_ARTIFACT_LIMITS.maxArtifactBytes) {
			throw new Error('plugin artifact exceeds byte limit');
		}
		assertArtifactBounds(artifact);
		const textByPath = new Map<string, string>();
		let byteLength = 0;
		for (const file of artifact.files) {
			const bytes = Buffer.from(file.content, 'base64');
			byteLength += bytes.byteLength;
			textByPath.set(file.path, bytes.toString('utf8'));
		}
		const authorizationFiles: Record<string, string> = {};
		for (const file of artifact.files) {
			if (file.path === SIGNATURE_FILENAME || isExcludedSignaturePath(file.path)) continue;
			authorizationFiles[file.path] = createHash('sha256')
				.update(Buffer.from(file.content, 'base64'))
				.digest('hex');
		}
		this.identity = Object.freeze({
			pluginId: artifact.pluginId,
			version: artifact.version,
			contractSha256: artifact.contractSha256,
			artifactSha256: createHash('sha256').update(sourceArtifact).digest('hex'),
			authorizationContentHash: createHash('sha256')
				.update(buildPluginContentHashPayload(authorizationFiles), 'utf8')
				.digest('hex'),
			signerKeyId: artifact.trustRoot.keyId,
		});
		this.storedByteLength = byteLength;
		this.textByPath = textByPath;
	}

	get fileCount(): number {
		return this.textByPath.size;
	}

	get byteLength(): number {
		return this.storedByteLength;
	}

	text(filePath: string): string | null {
		return this.textByPath.get(filePath) ?? null;
	}

	/** Drop every decoded byte when activation authority is revoked or replaced. */
	release(): void {
		this.textByPath.clear();
		this.storedByteLength = 0;
	}
}

export function createVerifiedPluginArtifactSnapshot(
	artifact: ParsedPluginArtifact,
	sourceArtifact: Uint8Array
): VerifiedPluginArtifactSnapshot {
	return new VerifiedPluginArtifactSnapshot(artifact, sourceArtifact);
}

/** Builds a canonical byte stream, so embedded and installable channels can assert byte equality. */
export function buildPluginArtifact(input: PluginArtifactInput): Buffer {
	validateArtifactInput(input);
	const unsigned = {
		schemaVersion: 1 as const,
		pluginId: input.pluginId,
		version: input.version,
		contractSha256: input.contractSha256,
		trustRoot: copyTrustRoot(input.trustRoot),
		files: canonicalFiles(input.files),
	};
	const signature = input.sign(Buffer.from(canonicalJson(unsigned)));
	if (signature.length === 0) throw new Error('plugin artifact signer returned an empty signature');
	return Buffer.from(`${canonicalJson({ ...unsigned, signature })}\n`, 'utf8');
}

export function parsePluginArtifact(
	artifact: Uint8Array,
	expectedTrustRoot?: ImmutableTrustRoot
): ParsedPluginArtifact {
	if (artifact.byteLength > PLUGIN_ARTIFACT_LIMITS.maxArtifactBytes) {
		throw new Error('plugin artifact exceeds byte limit');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(artifact).toString('utf8'));
	} catch {
		throw new Error('invalid plugin artifact JSON');
	}
	if (!isArtifact(parsed)) throw new Error('invalid plugin artifact shape');
	assertArtifactBounds(parsed);
	if (expectedTrustRoot && canonicalJson(parsed.trustRoot) !== canonicalJson(expectedTrustRoot)) {
		throw new Error('plugin artifact trust root mismatch');
	}
	return parsed;
}

export function verifySignedPluginArtifact(
	artifact: Uint8Array,
	trustRoot: ImmutableTrustRoot,
	verify: PluginArtifactSignatureVerifier
): ParsedPluginArtifact {
	const parsed = parsePluginArtifact(artifact, trustRoot);
	const { signature, ...unsigned } = parsed;
	if (!verify(Buffer.from(canonicalJson(unsigned)), signature, trustRoot)) {
		throw new Error('plugin artifact signature verification failed');
	}
	return parsed;
}

export function acceptPluginArtifact(
	current: PluginArtifactState | undefined,
	artifact: Uint8Array,
	trustRoot: ImmutableTrustRoot,
	verify: PluginArtifactSignatureVerifier
): PluginArtifactState {
	const parsed = verifySignedPluginArtifact(artifact, trustRoot, verify);
	const next: PluginArtifactState = {
		pluginId: parsed.pluginId,
		version: parsed.version,
		contractSha256: parsed.contractSha256,
		artifactSha256: createHash('sha256').update(artifact).digest('hex'),
	};
	if (!current) return next;
	if (current.pluginId !== next.pluginId) throw new Error('plugin artifact identity mismatch');
	if (compareVersions(next.version, current.version) < 0)
		throw new Error('plugin artifact downgrade refused');
	if (
		current.version === next.version &&
		(current.contractSha256 !== next.contractSha256 ||
			current.artifactSha256 !== next.artifactSha256)
	) {
		throw new Error('plugin artifact equivocation detected');
	}
	return next;
}

function validateArtifactInput(input: PluginArtifactInput): void {
	if (!/^[-a-z0-9.]+$/i.test(input.pluginId)) throw new Error('invalid plugin id');
	if (!/^\d+\.\d+\.\d+$/.test(input.version)) throw new Error('invalid plugin version');
	if (!/^[a-f0-9]{64}$/i.test(input.contractSha256))
		throw new Error('invalid plugin contract digest');
	if (!Object.isFrozen(input.trustRoot)) throw new Error('trust root metadata must be immutable');
	if (
		input.trustRoot.keyId.length === 0 ||
		input.trustRoot.algorithm.length === 0 ||
		input.trustRoot.publicKey.length === 0
	) {
		throw new Error('invalid trust root metadata');
	}
	const paths = new Set<string>();
	if (input.files.length === 0) throw new Error('plugin artifact has no files');
	if (input.files.length > PLUGIN_ARTIFACT_LIMITS.maxFiles) {
		throw new Error('plugin artifact exceeds file count limit');
	}
	let totalBytes = 0;
	for (const file of input.files) {
		validateArtifactPath(file.path);
		if (file.content.byteLength > PLUGIN_ARTIFACT_LIMITS.maxFileBytes) {
			throw new Error('plugin artifact file exceeds byte limit');
		}
		totalBytes += file.content.byteLength;
		if (totalBytes > PLUGIN_ARTIFACT_LIMITS.maxDecodedBytes) {
			throw new Error('plugin artifact exceeds decoded byte limit');
		}
		if (paths.has(file.path)) throw new Error(`duplicate plugin artifact path: ${file.path}`);
		paths.add(file.path);
	}
}

function canonicalFiles(files: readonly PluginArtifactFile[]): { path: string; content: string }[] {
	return [...files]
		.sort((left, right) => left.path.localeCompare(right.path))
		.map((file) => ({ path: file.path, content: Buffer.from(file.content).toString('base64') }));
}

function validateArtifactPath(filePath: string): void {
	const pathBytes = Buffer.byteLength(filePath, 'utf8');
	const pathDepth = filePath.split('/').length;
	if (
		filePath.length === 0 ||
		pathBytes > PLUGIN_ARTIFACT_LIMITS.maxPathLength ||
		pathDepth > PLUGIN_ARTIFACT_LIMITS.maxPathDepth ||
		filePath.startsWith('/') ||
		filePath.includes('\\') ||
		filePath.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
	) {
		throw new Error('unsafe plugin artifact path');
	}
}

function copyTrustRoot(trustRoot: ImmutableTrustRoot): ImmutableTrustRoot {
	return Object.freeze({
		keyId: trustRoot.keyId,
		algorithm: trustRoot.algorithm,
		publicKey: trustRoot.publicKey,
	});
}

function assertArtifactBounds(artifact: ParsedPluginArtifact): void {
	if (artifact.files.length === 0) throw new Error('plugin artifact has no files');
	if (artifact.files.length > PLUGIN_ARTIFACT_LIMITS.maxFiles) {
		throw new Error('plugin artifact exceeds file count limit');
	}
	const paths = new Set<string>();
	let totalDecodedBytes = 0;
	for (const file of artifact.files) {
		validateArtifactPath(file.path);
		if (paths.has(file.path)) throw new Error(`duplicate plugin artifact path: ${file.path}`);
		paths.add(file.path);
		const decodedBytes = base64DecodedByteLength(file.content);
		if (decodedBytes > PLUGIN_ARTIFACT_LIMITS.maxFileBytes) {
			throw new Error('plugin artifact file exceeds byte limit');
		}
		totalDecodedBytes += decodedBytes;
		if (totalDecodedBytes > PLUGIN_ARTIFACT_LIMITS.maxDecodedBytes) {
			throw new Error('plugin artifact exceeds decoded byte limit');
		}
	}
}

function base64DecodedByteLength(content: string): number {
	if (
		content.length === 0 ||
		content.length > PLUGIN_ARTIFACT_LIMITS.maxEncodedFileBytes ||
		content.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)
	) {
		throw new Error('invalid plugin artifact file encoding');
	}
	const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
	return (content.length / 4) * 3 - padding;
}

function isArtifact(value: unknown): value is ParsedPluginArtifact {
	if (!isRecord(value)) return false;
	if (
		value.schemaVersion !== 1 ||
		typeof value.pluginId !== 'string' ||
		!/^\d+\.\d+\.\d+$/.test(String(value.version))
	)
		return false;
	if (
		typeof value.contractSha256 !== 'string' ||
		!/^[a-f0-9]{64}$/i.test(value.contractSha256) ||
		typeof value.signature !== 'string' ||
		value.signature.length === 0
	)
		return false;
	if (!isTrustRoot(value.trustRoot) || !Array.isArray(value.files)) return false;
	return value.files.every(
		(file) => isRecord(file) && typeof file.path === 'string' && typeof file.content === 'string'
	);
}

function isTrustRoot(value: unknown): value is ImmutableTrustRoot {
	return (
		isRecord(value) &&
		typeof value.keyId === 'string' &&
		typeof value.algorithm === 'string' &&
		typeof value.publicKey === 'string'
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareVersions(left: string, right: string): number {
	const leftParts = left.split('.').map(Number);
	const rightParts = right.split('.').map(Number);
	for (let index = 0; index < 3; index += 1) {
		const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(',')}}`;
}
