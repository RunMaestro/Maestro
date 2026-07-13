import { randomBytes } from 'node:crypto';

import {
	MAX_EXTERNAL_SESSIONS_PER_WORKSPACE,
	parseWorkspaceLink,
	type CanonicalWorkspaceFoundation,
	type ExternalSessionStatus,
	type ParsedWorkspaceLink,
	type PublishedExternalSession,
	type SnapshotToken,
	type WorkspaceContextChange,
	type WorkspaceLinkResolution,
	type WorkspaceLocalId,
} from '../../shared/plugins/workspace-foundation';
import { captureException } from '../utils/sentry';

const SNAPSHOT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,86}$/;
const TOKEN_SEED_PATTERN = /^[A-Za-z0-9_-]{22,60}$/;
const INSTANCE_NONCE_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const MAX_TOKEN_EPOCH = 36 ** 8 - 1;
const MAX_EXTERNAL_SESSION_TITLE_SCALARS = 160;
const MAX_TOKEN_ATTEMPTS = 5;
export const MAX_STALE_TOKENS_PER_WORKSPACE = 1_000;
export const MAX_STALE_TOKENS_GLOBAL = 4_096;
export const MAX_EXTERNAL_SESSION_ID_BYTES = 256;

const REQUIRED_GRANTS = ['ui:workspace', 'ui:interactivePanel'] as const;
const EXTERNAL_SESSION_STATUSES = new Set<ExternalSessionStatus>([
	'starting',
	'idle',
	'working',
	'waiting_for_input',
	'waiting_for_approval',
	'retrying',
	'completed',
	'aborted',
	'failed',
	'offline',
]);

declare const workspaceCapabilityBrand: unique symbol;

/** An unforgeable, generation-bound authority issued by this registry only. */
export type WorkspaceCapability = object & {
	readonly [workspaceCapabilityBrand]: never;
};

export type { ExternalSessionStatus } from '../../shared/plugins/workspace-foundation';

export interface WorkspaceRegistryOwnerContext {
	readonly ownerPluginId: string;
	readonly generation: bigint;
	readonly trusted: boolean;
	readonly enabled: boolean;
	readonly grants: readonly string[];
}

export interface PluginWorkspaceRegistryOptions {
	readonly tokenSource: () => string;
	readonly isOwnerEnabled: (ownerPluginId: string) => boolean;
	readonly instanceNonce?: string;
}

export interface RegisteredWorkspace {
	readonly ownerPluginId: string;
	readonly workspaceLocalId: WorkspaceLocalId;
	readonly generation: bigint;
	readonly workspace: CanonicalWorkspaceFoundation['workspace'];
	readonly panel: CanonicalWorkspaceFoundation['panel'];
}

export type WorkspaceRegistryErrorCode =
	| 'invalid_workspace'
	| 'stale_generation'
	| 'capability_unavailable'
	| 'invalid_revision'
	| 'revision_not_increasing'
	| 'invalid_external_session'
	| 'too_many_external_sessions'
	| 'duplicate_external_session_id'
	| 'invalid_snapshot_token'
	| 'token_collision'
	| 'token_epoch_exhausted';

export class WorkspaceRegistryError extends Error {
	readonly name = 'WorkspaceRegistryError';

	constructor(readonly code: WorkspaceRegistryErrorCode) {
		super(code);
	}
}

interface InternalWorkspace {
	readonly key: string;
	readonly ownerPluginId: string;
	readonly workspaceLocalId: WorkspaceLocalId;
	readonly generation: bigint;
	readonly workspace: CanonicalWorkspaceFoundation['workspace'];
	readonly panel: CanonicalWorkspaceFoundation['panel'];
	readonly revision: number;
	readonly sessions: readonly PublishedExternalSession[];
	readonly selectedSnapshotToken: SnapshotToken | null;
}

interface CapabilityRecord {
	readonly workspaceKey: string;
	readonly ownerPluginId: string;
	readonly workspaceLocalId: WorkspaceLocalId;
	readonly generation: bigint;
}

interface TokenRecord {
	readonly ownerPluginId: string;
	readonly workspaceLocalId: WorkspaceLocalId;
	readonly workspaceKey: string;
	readonly generation: bigint;
	readonly session: PublishedExternalSession;
	readonly state: 'current' | 'expired' | 'revoked';
}

interface ValidatedSession {
	readonly externalSessionId: string;
	readonly title: string;
	readonly status: ExternalSessionStatus;
	readonly unread: number;
	readonly pendingApproval: boolean;
	readonly updatedAt: number;
}

/**
 * Main-process owner-qualified registry for a plugin's single declared
 * workspace/panel pair. It intentionally has no public IPC or SDK surface.
 */
export class PluginWorkspaceRegistry {
	private readonly workspaces = new Map<string, InternalWorkspace>();
	private readonly capabilities = new WeakMap<object, CapabilityRecord>();
	private readonly tokens = new Map<SnapshotToken, TokenRecord>();
	private readonly contextListeners = new Set<(context: WorkspaceContextChange) => void>();
	private readonly currentTokensByWorkspace = new Map<string, Set<SnapshotToken>>();
	private readonly staleTokensByWorkspace = new Map<string, Map<SnapshotToken, true>>();
	private readonly staleTokens = new Map<SnapshotToken, string>();
	private readonly instanceNonce: string;
	private tokenEpoch = 0;

	constructor(private readonly options: PluginWorkspaceRegistryOptions) {
		const instanceNonce = options.instanceNonce ?? randomBytes(12).toString('base64url');
		if (!INSTANCE_NONCE_PATTERN.test(instanceNonce)) {
			throw new WorkspaceRegistryError('invalid_snapshot_token');
		}
		this.instanceNonce = instanceNonce;
	}

	register(foundation: CanonicalWorkspaceFoundation, generation: bigint): void {
		if (!isValidFoundation(foundation) || typeof generation !== 'bigint') {
			throw new WorkspaceRegistryError('invalid_workspace');
		}

		const workspaceLocalId = foundation.workspace.localId;
		const key = workspaceKey(foundation.ownerPluginId, workspaceLocalId);
		const existing = this.workspaces.get(key);
		if (!existing) {
			this.workspaces.set(key, createWorkspace(key, foundation, generation));
			return;
		}
		if (generation < existing.generation) {
			throw new WorkspaceRegistryError('stale_generation');
		}
		if (generation === existing.generation) {
			this.workspaces.set(
				key,
				Object.freeze({
					...existing,
					workspace: freezeWorkspace(foundation.workspace),
					panel: freezePanel(foundation.panel),
				})
			);
			return;
		}

		const hadSelection = existing.selectedSnapshotToken !== null;
		this.revokeWorkspaceTokens(existing);
		this.workspaces.set(key, createWorkspace(key, foundation, generation));
		if (hadSelection) this.emitSelectionCleared(existing);
	}

	unregister(ownerPluginId: string, workspaceLocalId: string): void {
		const workspace = this.workspaces.get(workspaceKey(ownerPluginId, workspaceLocalId));
		if (!workspace) return;

		const hadSelection = workspace.selectedSnapshotToken !== null;
		this.revokeWorkspaceTokens(workspace);
		this.workspaces.delete(workspace.key);
		if (hadSelection) this.emitSelectionCleared(workspace);
	}

	acquire(context: WorkspaceRegistryOwnerContext, workspaceLocalId: string): WorkspaceCapability {
		if (!isOwnerContext(context)) {
			throw new WorkspaceRegistryError('capability_unavailable');
		}
		const workspace = this.workspaces.get(workspaceKey(context.ownerPluginId, workspaceLocalId));
		if (!workspace || !this.isAcquireAuthorized(context, workspace)) {
			throw new WorkspaceRegistryError('capability_unavailable');
		}

		const capability = Object.freeze(Object.create(null)) as WorkspaceCapability;
		this.capabilities.set(
			capability,
			Object.freeze({
				workspaceKey: workspace.key,
				ownerPluginId: workspace.ownerPluginId,
				workspaceLocalId: workspace.workspaceLocalId,
				generation: workspace.generation,
			})
		);
		return capability;
	}

	publishExternalSessions(
		capability: WorkspaceCapability,
		revision: number,
		snapshots: unknown
	): readonly PublishedExternalSession[] {
		const workspace = this.resolveCapability(capability);
		if (!Number.isSafeInteger(revision) || revision < 0) {
			throw new WorkspaceRegistryError('invalid_revision');
		}
		if (revision <= workspace.revision) {
			throw new WorkspaceRegistryError('revision_not_increasing');
		}
		if (!Array.isArray(snapshots)) {
			throw new WorkspaceRegistryError('invalid_external_session');
		}
		if (snapshots.length > MAX_EXTERNAL_SESSIONS_PER_WORKSPACE) {
			throw new WorkspaceRegistryError('too_many_external_sessions');
		}

		const nextSessions = this.mintPublishedSessions(workspace, validateSessions(snapshots));
		for (const prior of workspace.sessions) {
			this.markTokenStale(prior.snapshotToken, 'expired');
		}
		for (const session of nextSessions) {
			this.tokens.set(
				session.snapshotToken,
				Object.freeze({
					ownerPluginId: workspace.ownerPluginId,
					workspaceLocalId: workspace.workspaceLocalId,
					workspaceKey: workspace.key,
					generation: workspace.generation,
					session,
					state: 'current',
				})
			);
			this.addActiveToken(workspace.key, session.snapshotToken);
		}
		const selectionCleared =
			workspace.selectedSnapshotToken !== null &&
			!nextSessions.some((session) => session.snapshotToken === workspace.selectedSnapshotToken);
		this.workspaces.set(
			workspace.key,
			Object.freeze({
				...workspace,
				revision,
				sessions: nextSessions,
				selectedSnapshotToken: selectionCleared ? null : workspace.selectedSnapshotToken,
			})
		);
		if (selectionCleared) this.emitSelectionCleared(workspace);
		return cloneSessions(nextSessions);
	}

	getWorkspace(ownerPluginId: string, workspaceLocalId: string): RegisteredWorkspace | null {
		const workspace = this.workspaces.get(workspaceKey(ownerPluginId, workspaceLocalId));
		if (!workspace) return null;
		return {
			ownerPluginId: workspace.ownerPluginId,
			workspaceLocalId: workspace.workspaceLocalId,
			generation: workspace.generation,
			workspace: { ...workspace.workspace },
			panel: { ...workspace.panel },
		};
	}

	getExternalSessions(capability: WorkspaceCapability): readonly PublishedExternalSession[] {
		return cloneSessions(this.resolveCapability(capability).sessions);
	}

	setSelectedContext(capability: WorkspaceCapability, snapshotToken: string): void {
		const workspace = this.resolveCapability(capability);
		const token = this.tokens.get(snapshotToken as SnapshotToken);
		if (
			!token ||
			token.state !== 'current' ||
			token.workspaceKey !== workspace.key ||
			token.generation !== workspace.generation
		) {
			return;
		}

		this.workspaces.set(
			workspace.key,
			Object.freeze({ ...workspace, selectedSnapshotToken: token.session.snapshotToken })
		);
		this.emitContext(
			Object.freeze({
				kind: 'external-session-selected',
				ownerPluginId: workspace.ownerPluginId,
				workspaceLocalId: workspace.workspaceLocalId,
				snapshotToken: token.session.snapshotToken,
			})
		);
	}

	onDidChangeContext(listener: (context: WorkspaceContextChange) => void): () => void {
		this.contextListeners.add(listener);
		return () => this.contextListeners.delete(listener);
	}

	resolveWorkspaceLink(url: string): WorkspaceLinkResolution {
		const parsed = parseWorkspaceLink(url);
		if (!parsed) return { kind: 'syntax_invalid' };
		return this.resolveParsedLink(parsed);
	}

	private resolveCapability(capability: WorkspaceCapability): InternalWorkspace {
		const capabilityRecord =
			typeof capability === 'object' && capability !== null
				? this.capabilities.get(capability)
				: undefined;
		if (!capabilityRecord) throw new WorkspaceRegistryError('capability_unavailable');

		const workspace = this.workspaces.get(capabilityRecord.workspaceKey);
		if (
			!workspace ||
			workspace.generation !== capabilityRecord.generation ||
			!this.options.isOwnerEnabled(capabilityRecord.ownerPluginId)
		) {
			throw new WorkspaceRegistryError('capability_unavailable');
		}
		return workspace;
	}

	private isAcquireAuthorized(
		context: WorkspaceRegistryOwnerContext,
		workspace: InternalWorkspace
	): boolean {
		return (
			context !== null &&
			typeof context === 'object' &&
			context.ownerPluginId === workspace.ownerPluginId &&
			context.generation === workspace.generation &&
			context.trusted === true &&
			context.enabled === true &&
			this.options.isOwnerEnabled(workspace.ownerPluginId) &&
			Array.isArray(context.grants) &&
			REQUIRED_GRANTS.every((grant) => context.grants.includes(grant))
		);
	}

	private mintPublishedSessions(
		workspace: InternalWorkspace,
		validatedSessions: readonly ValidatedSession[]
	): readonly PublishedExternalSession[] {
		const stagedTokens = new Set<SnapshotToken>();
		const sessions: PublishedExternalSession[] = [];
		for (const session of validatedSessions) {
			const snapshotToken = this.mintToken(stagedTokens);
			stagedTokens.add(snapshotToken);
			sessions.push(
				Object.freeze({
					...session,
					snapshotToken,
				})
			);
		}
		return Object.freeze(sessions);
	}

	private mintToken(stagedTokens: ReadonlySet<SnapshotToken>): SnapshotToken {
		if (this.tokenEpoch > MAX_TOKEN_EPOCH) {
			throw new WorkspaceRegistryError('token_epoch_exhausted');
		}
		const epoch = this.tokenEpoch.toString(36).padStart(8, '0');
		for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt += 1) {
			const seed = this.options.tokenSource();
			if (typeof seed !== 'string' || !TOKEN_SEED_PATTERN.test(seed)) {
				throw new WorkspaceRegistryError('invalid_snapshot_token');
			}
			const candidate = `${this.instanceNonce}_${epoch}_${seed}`;
			if (!SNAPSHOT_TOKEN_PATTERN.test(candidate)) {
				throw new WorkspaceRegistryError('invalid_snapshot_token');
			}
			const snapshotToken = candidate as SnapshotToken;
			if (!this.tokens.has(snapshotToken) && !stagedTokens.has(snapshotToken)) {
				return snapshotToken;
			}
		}
		throw new WorkspaceRegistryError('token_collision');
	}

	private addActiveToken(workspaceKey: string, snapshotToken: SnapshotToken): void {
		let currentTokens = this.currentTokensByWorkspace.get(workspaceKey);
		if (!currentTokens) {
			currentTokens = new Set<SnapshotToken>();
			this.currentTokensByWorkspace.set(workspaceKey, currentTokens);
		}
		currentTokens.add(snapshotToken);
	}

	private markTokenStale(snapshotToken: SnapshotToken, state: 'expired' | 'revoked'): void {
		const tokenRecord = this.tokens.get(snapshotToken);
		if (!tokenRecord) return;
		this.tokens.set(snapshotToken, Object.freeze({ ...tokenRecord, state }));
		const currentTokens = this.currentTokensByWorkspace.get(tokenRecord.workspaceKey);
		currentTokens?.delete(snapshotToken);
		if (currentTokens?.size === 0) this.currentTokensByWorkspace.delete(tokenRecord.workspaceKey);

		let workspaceStaleTokens = this.staleTokensByWorkspace.get(tokenRecord.workspaceKey);
		if (!workspaceStaleTokens) {
			workspaceStaleTokens = new Map<SnapshotToken, true>();
			this.staleTokensByWorkspace.set(tokenRecord.workspaceKey, workspaceStaleTokens);
		}
		workspaceStaleTokens.delete(snapshotToken);
		workspaceStaleTokens.set(snapshotToken, true);
		this.staleTokens.delete(snapshotToken);
		this.staleTokens.set(snapshotToken, tokenRecord.workspaceKey);
		this.pruneStaleTokens(tokenRecord.workspaceKey);
	}

	private revokeWorkspaceTokens(workspace: InternalWorkspace): void {
		const currentTokens = this.currentTokensByWorkspace.get(workspace.key);
		if (currentTokens) {
			for (const snapshotToken of [...currentTokens]) {
				this.markTokenStale(snapshotToken, 'revoked');
			}
		}
		const staleTokens = this.staleTokensByWorkspace.get(workspace.key);
		if (staleTokens) {
			for (const snapshotToken of [...staleTokens.keys()]) {
				this.markTokenStale(snapshotToken, 'revoked');
			}
		}
	}

	private pruneStaleTokens(workspaceKey: string): void {
		const workspaceStaleTokens = this.staleTokensByWorkspace.get(workspaceKey);
		while (workspaceStaleTokens && workspaceStaleTokens.size > MAX_STALE_TOKENS_PER_WORKSPACE) {
			const oldest = workspaceStaleTokens.keys().next().value;
			if (oldest === undefined) break;
			this.deleteStaleToken(oldest, workspaceKey);
		}
		while (this.staleTokens.size > MAX_STALE_TOKENS_GLOBAL) {
			const oldest = this.staleTokens.entries().next().value;
			if (!oldest) break;
			this.deleteStaleToken(oldest[0], oldest[1]);
		}
	}

	private deleteStaleToken(snapshotToken: SnapshotToken, workspaceKey: string): void {
		this.tokens.delete(snapshotToken);
		this.staleTokens.delete(snapshotToken);
		const workspaceStaleTokens = this.staleTokensByWorkspace.get(workspaceKey);
		workspaceStaleTokens?.delete(snapshotToken);
		if (workspaceStaleTokens?.size === 0) this.staleTokensByWorkspace.delete(workspaceKey);
		this.tokenEpoch = Math.min(this.tokenEpoch + 1, MAX_TOKEN_EPOCH + 1);
	}

	private emitSelectionCleared(workspace: InternalWorkspace): void {
		this.emitContext(
			Object.freeze({
				kind: 'selection-cleared',
				ownerPluginId: workspace.ownerPluginId,
				workspaceLocalId: workspace.workspaceLocalId,
			})
		);
	}

	private emitContext(context: WorkspaceContextChange): void {
		const listeners = [...this.contextListeners];
		for (const listener of listeners) {
			try {
				listener(context);
			} catch (error) {
				void captureException(error instanceof Error ? error : new Error(String(error)), {
					extra: { scope: 'PluginWorkspaceRegistry.emitContext' },
				});
			}
		}
	}

	private resolveParsedLink(parsed: ParsedWorkspaceLink): WorkspaceLinkResolution {
		const token = this.tokens.get(parsed.snapshotToken);
		if (!token) return { kind: 'unknown_token' };
		if (
			token.ownerPluginId !== parsed.pluginId ||
			token.workspaceLocalId !== parsed.workspaceLocalId
		) {
			return { kind: 'foreign_owner' };
		}
		if (token.state === 'revoked') return { kind: 'revoked' };
		if (token.state === 'expired') return { kind: 'expired' };
		if (!this.options.isOwnerEnabled(token.ownerPluginId)) return { kind: 'disabled_owner' };

		const workspace = this.workspaces.get(token.workspaceKey);
		if (!workspace || workspace.generation !== token.generation) return { kind: 'revoked' };
		return {
			kind: 'resolved',
			ownerPluginId: token.ownerPluginId,
			workspaceLocalId: token.workspaceLocalId,
			externalSession: cloneSession(token.session),
		};
	}
}

function workspaceKey(ownerPluginId: string, workspaceLocalId: string): string {
	return `${ownerPluginId}\u0000${workspaceLocalId}`;
}

function createWorkspace(
	key: string,
	foundation: CanonicalWorkspaceFoundation,
	generation: bigint
): InternalWorkspace {
	return Object.freeze({
		key,
		ownerPluginId: foundation.ownerPluginId,
		workspaceLocalId: foundation.workspace.localId,
		generation,
		workspace: freezeWorkspace(foundation.workspace),
		panel: freezePanel(foundation.panel),
		revision: -1,
		sessions: Object.freeze([]),
		selectedSnapshotToken: null,
	});
}

function freezeWorkspace(
	workspace: CanonicalWorkspaceFoundation['workspace']
): CanonicalWorkspaceFoundation['workspace'] {
	return Object.freeze({ ...workspace });
}

function freezePanel(
	panel: CanonicalWorkspaceFoundation['panel']
): CanonicalWorkspaceFoundation['panel'] {
	return Object.freeze({ ...panel });
}

function validateSessions(snapshots: readonly unknown[]): readonly ValidatedSession[] {
	const externalSessionIds = new Set<string>();
	const validated: ValidatedSession[] = [];
	for (const snapshot of snapshots) {
		const session = validateSession(snapshot);
		if (externalSessionIds.has(session.externalSessionId)) {
			throw new WorkspaceRegistryError('duplicate_external_session_id');
		}
		externalSessionIds.add(session.externalSessionId);
		validated.push(session);
	}
	return validated;
}

function validateSession(snapshot: unknown): ValidatedSession {
	if (!isPlainObject(snapshot)) throw new WorkspaceRegistryError('invalid_external_session');
	const externalSessionId = readOwnDataProperty(snapshot, 'externalSessionId');
	const title = readOwnDataProperty(snapshot, 'title');
	const status = readOwnDataProperty(snapshot, 'status');
	const unread = readOwnDataProperty(snapshot, 'unread');
	const pendingApproval = readOwnDataProperty(snapshot, 'pendingApproval');
	const updatedAt = readOwnDataProperty(snapshot, 'updatedAt');
	if (
		typeof externalSessionId !== 'string' ||
		externalSessionId.length === 0 ||
		!isWellFormedUnicode(externalSessionId) ||
		utf8ByteLength(externalSessionId, MAX_EXTERNAL_SESSION_ID_BYTES) >
			MAX_EXTERNAL_SESSION_ID_BYTES ||
		typeof title !== 'string' ||
		!isValidTitle(title) ||
		typeof status !== 'string' ||
		!EXTERNAL_SESSION_STATUSES.has(status as ExternalSessionStatus) ||
		typeof unread !== 'number' ||
		!Number.isInteger(unread) ||
		unread < 0 ||
		unread > 9_999 ||
		typeof pendingApproval !== 'boolean' ||
		typeof updatedAt !== 'number' ||
		!Number.isFinite(updatedAt) ||
		updatedAt < 0
	) {
		throw new WorkspaceRegistryError('invalid_external_session');
	}
	return {
		externalSessionId,
		title,
		status: status as ExternalSessionStatus,
		unread,
		pendingApproval,
		updatedAt,
	};
}

function isValidTitle(title: string): boolean {
	if (title.length === 0) return false;
	let scalarCount = 0;
	for (let index = 0; index < title.length; index += 1) {
		const codeUnit = title.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			if (
				index + 1 >= title.length ||
				title.charCodeAt(index + 1) < 0xdc00 ||
				title.charCodeAt(index + 1) > 0xdfff
			) {
				return false;
			}
			index += 1;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return false;
		}
		scalarCount += 1;
		if (scalarCount > MAX_EXTERNAL_SESSION_TITLE_SCALARS) return false;
	}
	return true;
}

function isWellFormedUnicode(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			if (
				index + 1 >= value.length ||
				value.charCodeAt(index + 1) < 0xdc00 ||
				value.charCodeAt(index + 1) > 0xdfff
			) {
				return false;
			}
			index += 1;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function utf8ByteLength(value: string, limit: number): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit <= 0x7f) {
			bytes += 1;
		} else if (codeUnit <= 0x7ff) {
			bytes += 2;
		} else if (
			codeUnit >= 0xd800 &&
			codeUnit <= 0xdbff &&
			index + 1 < value.length &&
			value.charCodeAt(index + 1) >= 0xdc00 &&
			value.charCodeAt(index + 1) <= 0xdfff
		) {
			bytes += 4;
			index += 1;
		} else {
			bytes += 3;
		}
		if (bytes > limit) return bytes;
	}
	return bytes;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object') return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isOwnerContext(value: unknown): value is WorkspaceRegistryOwnerContext {
	return (
		isPlainObject(value) &&
		typeof value.ownerPluginId === 'string' &&
		typeof value.generation === 'bigint' &&
		typeof value.trusted === 'boolean' &&
		typeof value.enabled === 'boolean' &&
		Array.isArray(value.grants) &&
		value.grants.every((grant) => typeof grant === 'string')
	);
}

function readOwnDataProperty(object: Record<string, unknown>, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function cloneSessions(
	sessions: readonly PublishedExternalSession[]
): readonly PublishedExternalSession[] {
	return sessions.map(cloneSession);
}

function cloneSession(session: PublishedExternalSession): PublishedExternalSession {
	return {
		externalSessionId: session.externalSessionId,
		title: session.title,
		status: session.status,
		unread: session.unread,
		pendingApproval: session.pendingApproval,
		updatedAt: session.updatedAt,
		snapshotToken: session.snapshotToken,
	};
}

function isValidFoundation(foundation: CanonicalWorkspaceFoundation): boolean {
	return (
		foundation !== null &&
		typeof foundation === 'object' &&
		typeof foundation.ownerPluginId === 'string' &&
		typeof foundation.workspace?.localId === 'string' &&
		typeof foundation.panel?.localId === 'string'
	);
}
