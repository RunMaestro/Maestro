import { EventEmitter } from 'events';
import type {
	AgentDispatchFleetEntry,
	AgentDispatchFleetEvent,
	AgentDispatchFleetEventType,
	AgentDispatchProfile,
	AgentDispatchSettings,
	AgentDispatchSshRemoteMetadata,
} from '../../shared/agent-dispatch-types';
import {
	DEFAULT_AGENT_DISPATCH_PROFILE,
	DEFAULT_AGENT_DISPATCH_SETTINGS,
} from '../../shared/agent-dispatch-types';
import type {
	WorkGraphBroadcastEnvelope,
	WorkGraphBroadcastOperation,
	WorkItemClaim,
} from '../../shared/work-graph-types';
import type { AgentDefinition } from '../agents/definitions';
import type { ManagedProcess } from '../process-manager/types';
import type { StoredSession } from '../stores/types';
import type { SshRemoteConfig } from '../../shared/types';
import { deriveAgentDispatchReadiness } from './readiness';

export interface FleetRegistrySnapshotInput {
	sessions: StoredSession[];
	processes?: ManagedProcess[];
	agentDefinitions?: AgentDefinition[];
	dispatchProfiles?: Record<string, AgentDispatchProfile | undefined>;
	dispatchSettings?: AgentDispatchSettings;
	sshRemotes?: SshRemoteConfig[];
	activeClaims?: WorkItemClaim[];
	now?: Date;
}

export interface FleetRegistryOptions {
	publishWorkGraphEvent?: (
		operation: WorkGraphBroadcastOperation,
		payload: unknown
	) => WorkGraphBroadcastEnvelope | undefined;
}

type FleetRegistryEventMap = {
	[eventType in AgentDispatchFleetEventType]: [AgentDispatchFleetEvent];
};

export class FleetRegistry extends EventEmitter {
	private readonly pauseState = new Set<string>();
	private readonly entries = new Map<string, AgentDispatchFleetEntry>();
	private readonly publishWorkGraphEvent?: FleetRegistryOptions['publishWorkGraphEvent'];

	constructor(options: FleetRegistryOptions = {}) {
		super();
		this.publishWorkGraphEvent = options.publishWorkGraphEvent;
	}

	override on<K extends keyof FleetRegistryEventMap>(
		eventName: K,
		listener: (...args: FleetRegistryEventMap[K]) => void
	): this {
		return super.on(eventName, listener);
	}

	override emit<K extends keyof FleetRegistryEventMap>(
		eventName: K,
		...args: FleetRegistryEventMap[K]
	): boolean {
		return super.emit(eventName, ...args);
	}

	pause(entryId: string): AgentDispatchFleetEntry | undefined {
		this.pauseState.add(entryId);
		return this.entries.get(entryId);
	}

	resume(entryId: string): AgentDispatchFleetEntry | undefined {
		this.pauseState.delete(entryId);
		return this.entries.get(entryId);
	}

	isPaused(entryId: string): boolean {
		return this.pauseState.has(entryId);
	}

	getEntries(): AgentDispatchFleetEntry[] {
		return [...this.entries.values()];
	}

	getEntry(entryId: string): AgentDispatchFleetEntry | undefined {
		return this.entries.get(entryId);
	}

	refresh(input: FleetRegistrySnapshotInput): AgentDispatchFleetEntry[] {
		const nextEntries = buildFleetEntries(input, this.pauseState);
		const nextById = new Map(nextEntries.map((entry) => [entry.id, entry]));
		const removedIds = [...this.entries.keys()].filter((entryId) => !nextById.has(entryId));

		for (const entry of nextEntries) {
			const previous = this.entries.get(entry.id);
			this.entries.set(entry.id, entry);
			this.emitEntryChanges(entry, previous);
		}

		for (const entryId of removedIds) {
			this.entries.delete(entryId);
			this.pauseState.delete(entryId);
		}

		return nextEntries;
	}

	private emitEntryChanges(
		entry: AgentDispatchFleetEntry,
		previous: AgentDispatchFleetEntry | undefined
	): void {
		if (!previous) {
			this.emitFleetEvent('agentDispatch.fleet.changed', entry, previous);
			return;
		}

		if (previous.readiness !== entry.readiness) {
			this.emitFleetEvent('agentDispatch.agent.readinessChanged', entry, previous);
		}
		if (previous.currentLoad !== entry.currentLoad) {
			this.emitFleetEvent('agentDispatch.agent.claimsChanged', entry, previous);
		}
		if (previous.pickupEnabled !== entry.pickupEnabled) {
			this.emitFleetEvent('agentDispatch.agent.pickupChanged', entry, previous);
		}
		if (!fleetEntriesEqual(previous, entry)) {
			this.emitFleetEvent('agentDispatch.fleet.changed', entry, previous);
		}
	}

	private emitFleetEvent(
		type: AgentDispatchFleetEventType,
		entry: AgentDispatchFleetEntry,
		previous: AgentDispatchFleetEntry | undefined
	): void {
		const event: AgentDispatchFleetEvent = {
			type,
			entry,
			previous,
			timestamp: new Date().toISOString(),
		};

		this.emit(type, event);
		this.publishWorkGraphEvent?.(type, { event, fleetEntry: entry, previous });
	}
}

export function buildFleetEntries(
	input: FleetRegistrySnapshotInput,
	pauseState: Set<string> = new Set()
): AgentDispatchFleetEntry[] {
	const {
		sessions,
		processes = [],
		agentDefinitions = [],
		dispatchProfiles = {},
		dispatchSettings = DEFAULT_AGENT_DISPATCH_SETTINGS,
		sshRemotes = [],
		activeClaims = [],
		now = new Date(),
	} = input;
	const processesBySessionId = new Map(processes.map((process) => [process.sessionId, process]));
	const claimsByOwnerId = groupClaimsByOwnerId(activeClaims);
	const definitionsById = new Map(
		agentDefinitions.map((definition) => [definition.id, definition])
	);
	const sshRemotesById = new Map(sshRemotes.map((remote) => [remote.id, remote]));
	const timestamp = now.toISOString();

	return sessions.map((session) => {
		const entryId = getFleetEntryId(session);
		const agentId = session.toolType;
		const definition = definitionsById.get(agentId);
		const dispatchProfile =
			dispatchProfiles[agentId] ??
			normalizeDispatchProfile(definition?.dispatchSuggestedDefaults, session.dispatchProfile);
		const sshRemote = getSshRemoteMetadata(session, sshRemotesById);
		const locality = sshRemote ? 'ssh' : 'local';
		const process = processesBySessionId.get(session.id);
		const currentClaims = claimsByOwnerId.get(entryId) ?? claimsByOwnerId.get(session.id) ?? [];
		// TODO #433: simplify under 4-slot model; maxConcurrentClaims is deprecated
		const readiness = deriveAgentDispatchReadiness({
			session: {
				state: session.state,
				agentError: session.agentError,
				agentErrorPaused: session.agentErrorPaused,
				sshConnectionFailed: session.sshConnectionFailed,
				aiPid: session.aiPid,
				terminalPid: session.terminalPid,
			},
			processActive: !!process,
			paused: pauseState.has(entryId),
			activeClaims: currentClaims,
			maxConcurrentClaims: dispatchProfile.maxConcurrentClaims,
		});

		return {
			id: entryId,
			agentId,
			sessionId: session.id,
			providerSessionId: getProviderSessionId(session),
			displayName: session.name || definition?.name || agentId,
			providerType: agentId,
			host: sshRemote?.host ?? 'local',
			locality,
			sshRemote,
			readiness,
			currentClaims,
			currentLoad: currentClaims.filter((claim) => claim.status === 'active').length,
			// TODO #433: simplify under 4-slot model; capabilityTags is deprecated
			dispatchCapabilities: dispatchProfile.capabilityTags,
			dispatchProfile,
			pickupEnabled: isPickupEnabled(session, sshRemote, dispatchProfile, dispatchSettings),
			updatedAt: timestamp,
		};
	});
}

function getFleetEntryId(session: StoredSession): string {
	return session.id;
}

function getProviderSessionId(session: StoredSession): string | undefined {
	const activeTab = Array.isArray(session.aiTabs)
		? session.aiTabs.find((tab: { id?: string }) => tab.id === session.activeTabId)
		: undefined;
	return activeTab?.agentSessionId ?? session.agentSessionId;
}

function getSshRemoteMetadata(
	session: StoredSession,
	sshRemotesById: Map<string, SshRemoteConfig>
): AgentDispatchSshRemoteMetadata | undefined {
	const resolved =
		resolveSessionSshRemoteId(session, 'sshRemoteId') ??
		resolveSessionSshRemoteId(session, 'sessionSshRemoteConfig') ??
		resolveSessionSshRemoteId(session, 'sshRemote');

	if (!resolved) {
		return undefined;
	}

	const remote = sshRemotesById.get(resolved.id);
	return {
		id: resolved.id,
		name: remote?.name ?? session.sshRemote?.name,
		host: remote?.host ?? session.sshRemote?.host,
		workingDirOverride: session.sessionSshRemoteConfig?.workingDirOverride,
		enabled: remote?.enabled,
		source: resolved.source,
	};
}

function resolveSessionSshRemoteId(
	session: StoredSession,
	source: 'sshRemoteId' | 'sessionSshRemoteConfig' | 'sshRemote'
):
	| {
			id: string;
			source: AgentDispatchSshRemoteMetadata['source'];
	  }
	| undefined {
	if (source === 'sshRemoteId' && typeof session.sshRemoteId === 'string' && session.sshRemoteId) {
		return { id: session.sshRemoteId, source: 'session.sshRemoteId' };
	}
	if (
		source === 'sessionSshRemoteConfig' &&
		session.sessionSshRemoteConfig?.enabled &&
		typeof session.sessionSshRemoteConfig.remoteId === 'string' &&
		session.sessionSshRemoteConfig.remoteId
	) {
		return {
			id: session.sessionSshRemoteConfig.remoteId,
			source: 'session.sessionSshRemoteConfig.remoteId',
		};
	}
	if (source === 'sshRemote' && typeof session.sshRemote?.id === 'string' && session.sshRemote.id) {
		return { id: session.sshRemote.id, source: 'session.sshRemote.id' };
	}
	return undefined;
}

function normalizeDispatchProfile(
	suggestedDefaults: AgentDefinition['dispatchSuggestedDefaults'] | undefined,
	storedProfile: AgentDispatchProfile | undefined
): AgentDispatchProfile {
	// TODO #433: simplify under 4-slot model; remove deprecated fields and suggested defaults
	return {
		autoPickupEnabled:
			storedProfile?.autoPickupEnabled ?? DEFAULT_AGENT_DISPATCH_PROFILE.autoPickupEnabled,
		capabilityTags:
			storedProfile?.capabilityTags ??
			suggestedDefaults?.capabilityTags ??
			DEFAULT_AGENT_DISPATCH_PROFILE.capabilityTags,
		maxConcurrentClaims:
			storedProfile?.maxConcurrentClaims ??
			suggestedDefaults?.maxConcurrentClaims ??
			DEFAULT_AGENT_DISPATCH_PROFILE.maxConcurrentClaims,
		...(suggestedDefaults ? { suggestedDefaults } : {}),
	};
}

function isPickupEnabled(
	session: StoredSession,
	sshRemote: AgentDispatchSshRemoteMetadata | undefined,
	dispatchProfile: AgentDispatchProfile,
	dispatchSettings: AgentDispatchSettings
): boolean {
	if (!dispatchSettings.globalAutoPickupEnabled || !dispatchProfile.autoPickupEnabled) {
		return false;
	}

	const projectPath = session.projectRoot || session.cwd;
	if (projectPath && dispatchSettings.projectAutoPickupEnabled[projectPath] === false) {
		return false;
	}
	if (sshRemote && dispatchSettings.sshRemoteAutoPickupEnabled[sshRemote.id] === false) {
		return false;
	}

	return true;
}

function groupClaimsByOwnerId(activeClaims: WorkItemClaim[]): Map<string, WorkItemClaim[]> {
	const grouped = new Map<string, WorkItemClaim[]>();
	for (const claim of activeClaims) {
		if (claim.status !== 'active') continue;
		const existing = grouped.get(claim.owner.id) ?? [];
		existing.push(claim);
		grouped.set(claim.owner.id, existing);
	}
	return grouped;
}

function fleetEntriesEqual(
	previous: AgentDispatchFleetEntry,
	next: AgentDispatchFleetEntry
): boolean {
	const { updatedAt: _previousUpdatedAt, ...previousComparable } = previous;
	const { updatedAt: _nextUpdatedAt, ...nextComparable } = next;
	return JSON.stringify(previousComparable) === JSON.stringify(nextComparable);
}
