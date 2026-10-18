import type { ToolType } from '../../types';

export interface TranslationIdentity {
	provider: ToolType;
	version: string;
	accountRoot: string;
	/** Canonical Claude projects directory selected with the account, including shared profile links. */
	nativeSessionRoot?: string;
	projectRoot: string;
	/** Repository identity for default project memory; session cwd remains projectRoot. */
	memoryProjectRoot?: string;
	/** Host-approved user resource roots, e.g. ~/.agents/skills. Never provider home defaults. */
	userResourceRoots?: Array<{
		path: string;
		kind: 'skill' | 'memory' | 'instruction' | 'subagent';
	}>;
}

/** Native identity includes the account, so equal session IDs in two homes never collide. */
export interface RecordOrigin {
	provider: ToolType;
	account: string;
	sessionId: string;
	eventId: string;
}

export type PortableBlock =
	| { kind: 'text'; text: string }
	| { kind: 'tool-call'; callId: string; name: string; input: unknown; custom?: boolean }
	| { kind: 'tool-result'; callId: string; output: unknown; isError?: boolean; custom?: boolean }
	| { kind: 'attachment'; artifactId: string; mediaType: string; native: unknown }
	| { kind: 'opaque'; native: unknown };

export interface PortableRecord {
	origin: RecordOrigin;
	semanticHash: string;
	nativeId: string;
	sequence: number;
	role?: 'user' | 'assistant' | 'system' | 'developer';
	blocks: PortableBlock[];
	parentId?: string;
	branchId?: string;
	timestamp?: string;
	phase?: string;
	boundary?: 'compaction' | 'fork';
	/** Native record is evidence. It must never become a foreign system instruction. */
	native: unknown;
}

export interface TranslationArtifact {
	id: string;
	kind: 'transcript' | 'attachment' | 'memory' | 'instruction' | 'skill' | 'subagent';
	sourcePath: string;
	originPath?: string;
	originSha256?: string;
	relativePath: string;
	sha256: string;
	bytesBase64: string;
	scope: 'project' | 'selected-user';
	/** Keep only owner read/write/execute permissions in the destination. */
	mode?: number;
	symlinkTarget?: string;
	metadata?: Record<string, unknown>;
}

export interface TranslationLimitation {
	code: string;
	message: string;
	severity: 'warning' | 'block';
	artifactId?: string;
	tabId?: string;
}

export interface PortableConversation {
	tabId: string;
	nativeSessionId: string | null;
	identity: TranslationIdentity;
	records: PortableRecord[];
	artifacts: TranslationArtifact[];
	limitations: TranslationLimitation[];
}

export interface TranslationScope {
	/** Exact paths selected by the user; never an implicit account-wide import. */
	selectedUserResources: string[];
	projectKnowledge: true;
}

export interface TranslationCheckpoint {
	/** Every observed native record, including display projections and opaque rows. */
	observed: Record<string, string>;
	/** Written native IDs -> original lineage; repeated text is not an identity. */
	lineage: Record<string, RecordOrigin>;
	conversations: PortableConversation[];
	resources: TranslationArtifact[];
	resourceBases: Record<string, string | null>;
	providerRoots: Partial<Record<ToolType, TranslationIdentity>>;
	/** Native resource discovery files created by this agent's migrations only. */
	ownedResources?: Record<
		string,
		{ sha256: string; resourceKey: string; format: 'markdown' | 'toml' | 'binary' }
	>;
	resourceTombstones?: Record<string, { originPath: string; originSha256: string }>;
}

export interface TranslationTabMapping {
	tabId: string;
	sourceSessionId: string | null;
	destinationSessionId: string | null;
	/** Output is a new session; older parked sessions remain recoverable. */
	artifacts: OwnedTranslationWrite[];
	lineage: Record<string, RecordOrigin>;
}

export type HistoryTranslationMapping = Pick<
	TranslationTabMapping,
	'tabId' | 'sourceSessionId' | 'destinationSessionId'
>;

export interface OwnedTranslationWrite {
	path: string;
	sha256: string;
	/** Only exclusively created files may be removed during rollback. */
	created: boolean;
	/** Provider-owned indexes cannot be undone by unlinking a rollout. */
	cleanup?: 'retain';
	backup?: TranslationArtifact;
	resourceKey?: string;
	format?: 'markdown' | 'toml' | 'binary';
	symlinkTarget?: string;
	deleted?: boolean;
	mode?: number;
}

export interface ResourceProjection extends OwnedTranslationWrite {
	bytesBase64: string;
	expectedHash: string | null;
}

export interface TranslationDirection {
	source: TranslationIdentity['provider'];
	destination: TranslationIdentity['provider'];
	sourceVersions: readonly string[];
	destinationVersions: readonly string[];
	verification: 'unverified' | 'verified';
	/** Verified declarations require recorded native reload, round-trip and capability evidence. */
	evidence?: {
		nativeResume: string;
		roundTrip: string;
		resources: string;
		payloadClasses: string[];
	};
}

export interface TranslationPlan {
	schemaVersion: 1;
	id: string;
	agentId: string;
	source: TranslationIdentity;
	destination: TranslationIdentity;
	scope: TranslationScope;
	status: 'noop' | 'ready' | 'blocked' | 'deferred';
	verification: 'unverified' | 'verified';
	limitations: TranslationLimitation[];
	tabs: Array<{
		tabId: string;
		sourceSessionId: string | null;
		records: number;
		newRecords: number;
	}>;
	counts: { records: number; artifacts: number; bytes: number };
	fingerprint: string;
}

export type TranslationOperationState =
	| 'planned'
	| 'staging'
	| 'staged'
	| 'committing'
	| 'committed'
	| 'failed'
	| 'rolled-back'
	| 'recovery-required';

/** Persist this reference, not private native content, on the Maestro agent. */
export interface ProviderMigrationState {
	operationId: string;
	destination: ToolType;
	state: TranslationOperationState | 'deferred';
	verification: 'unverified' | 'verified';
	error?: string;
	acceptLimitations?: boolean;
	selectedUserResources?: string[];
	/** Canonical complete limitations; legacy code/artifact keys require renewed review. */
	acceptedLimitationCodes?: string[];
}

export interface TranslationResult {
	success: boolean;
	state: TranslationOperationState | 'deferred' | 'refused' | 'noop';
	plan: TranslationPlan;
	mappings: TranslationTabMapping[];
	error?: string;
}

export interface TranslationRequest {
	agentId: string;
	destination: ToolType;
	action: 'plan' | 'apply' | 'status' | 'recover' | 'rollback';
	acceptLimitations?: boolean;
	planId?: string;
	selectedUserResources?: string[];
}

export interface TranslationReport {
	success: boolean;
	plan?: TranslationPlan;
	result?: TranslationResult;
	error?: string;
}

export class TranslationSourceBusyError extends Error {
	constructor() {
		super('Source turn is still active; migration waits for final native events');
		this.name = 'TranslationSourceBusyError';
	}
}

export interface TranslationAdapter {
	provider: ToolType;
	/** Schema versions exercised by synthetic cases, not native resume certification. */
	versions: readonly string[];
	extract(
		identity: TranslationIdentity,
		tabId: string,
		sessionId: string,
		bytes: Buffer
	): PortableConversation;
	stage(
		conversation: PortableConversation,
		context: TranslationStageContext
	): Promise<TranslationTabMapping>;
}

export interface TranslationStageContext {
	operationId: string;
	destination: TranslationIdentity;
	/** Must journal ownership BEFORE any provider mutation. */
	recordIntent(mapping: TranslationTabMapping): Promise<void>;
	codex?: TranslationRpc;
}

export interface TranslationRpc {
	request<T = unknown>(method: string, params?: unknown): Promise<T>;
	/** Subscribe before requesting an import; notifications may precede the response. */
	onNotification(listener: (method: string, params: unknown) => void): () => void;
}
