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

const SNAPSHOT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,86}$/;
const MAX_EXTERNAL_SESSION_TITLE_SCALARS = 160;
const MAX_TOKEN_ATTEMPTS = 5;
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
	| 'token_collision';

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

	constructor(private readonly options: PluginWorkspaceRegistryOptions) {}

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

		this.clearSelection(existing);
		this.revokeWorkspaceTokens(existing);
		this.workspaces.set(key, createWorkspace(key, foundation, generation));
	}

	unregister(ownerPluginId: string, workspaceLocalId: string): void {
		const workspace = this.workspaces.get(workspaceKey(ownerPluginId, workspaceLocalId));
		if (!workspace) return;

		this.clearSelection(workspace);
		this.revokeWorkspaceTokens(workspace);
		this.workspaces.delete(workspace.key);
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
			const token = this.tokens.get(prior.snapshotToken);
			if (token?.state === 'current') {
				this.tokens.set(prior.snapshotToken, Object.freeze({ ...token, state: 'expired' }));
			}
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
		if (selectionCleared) {
			this.emitContext(
				Object.freeze({
					kind: 'selection-cleared',
					ownerPluginId: workspace.ownerPluginId,
					workspaceLocalId: workspace.workspaceLocalId,
				})
			);
		}
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
		for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt += 1) {
			const candidate = this.options.tokenSource();
			if (typeof candidate !== 'string' || !SNAPSHOT_TOKEN_PATTERN.test(candidate)) {
				throw new WorkspaceRegistryError('invalid_snapshot_token');
			}
			const snapshotToken = candidate as SnapshotToken;
			if (!this.tokens.has(snapshotToken) && !stagedTokens.has(snapshotToken)) {
				return snapshotToken;
			}
		}
		throw new WorkspaceRegistryError('token_collision');
	}

	private revokeWorkspaceTokens(workspace: InternalWorkspace): void {
		for (const [snapshotToken, tokenRecord] of this.tokens) {
			if (tokenRecord.workspaceKey === workspace.key) {
				this.tokens.set(snapshotToken, Object.freeze({ ...tokenRecord, state: 'revoked' }));
			}
		}
	}

	private clearSelection(workspace: InternalWorkspace): void {
		if (workspace.selectedSnapshotToken === null) return;
		this.workspaces.set(
			workspace.key,
			Object.freeze({ ...workspace, selectedSnapshotToken: null })
		);
		this.emitContext(
			Object.freeze({
				kind: 'selection-cleared',
				ownerPluginId: workspace.ownerPluginId,
				workspaceLocalId: workspace.workspaceLocalId,
			})
		);
	}

	private emitContext(context: WorkspaceContextChange): void {
		for (const listener of this.contextListeners) listener(context);
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
