import type { EventEmitter } from 'events';
import type {
	AgentDispatchProfile,
	AgentDispatchSettings,
	WorkItemClaim,
} from '../../shared/agent-dispatch-types';
import {
	AGENT_DISPATCH_PROFILE_CONFIG_KEY,
	DEFAULT_AGENT_DISPATCH_PROFILE,
	DEFAULT_AGENT_DISPATCH_SETTINGS,
} from '../../shared/agent-dispatch-types';
import type {
	WorkGraphActor,
	WorkGraphListResult,
	WorkItem,
	WorkItemClaimInput,
	WorkItemFilters,
} from '../../shared/work-graph-types';
import type { WorkGraphStorage } from '../work-graph/storage';
import type { SshRemoteConfig } from '../../shared/types';
import { AGENT_DEFINITIONS, type AgentDefinition } from '../agents/definitions';
import type { ManagedProcess } from '../process-manager';
import type { StoredSession } from '../stores/types';
import { logger } from '../utils/logger';
import { getWorkGraphItemStore, publishWorkGraphEvent } from '../work-graph';
import { subscribeWorkGraphEvents } from '../work-graph/events';
import { AgentDispatchEngine, type AgentDispatchWorkGraphStore } from './dispatch-engine';
import { FleetRegistry } from './fleet-registry';
import { ClaimHeartbeat, type HeartbeatWorkGraphStore } from './heartbeat';
import { ManualOverride, type ManualOverrideWorkGraphStore } from './manual-override';
import { createExecutorBridge, type AutoRunTrigger, type ExecutorBridge } from './executor-bridge';
import { createSshRemoteStoreAdapter } from '../utils/ssh-remote-resolver';

type StoreSubscription = () => void;

interface ReadStore<T> {
	get<K extends keyof T>(key: K, defaultValue: T[K]): T[K];
	onDidChange?<K extends keyof T>(
		key: K,
		callback: (newValue: T[K] | undefined, oldValue: T[K] | undefined) => void
	): StoreSubscription;
}

interface SettingsStore {
	get(key: 'dispatchSettings', defaultValue: AgentDispatchSettings): AgentDispatchSettings;
	get(key: 'sshRemotes', defaultValue: SshRemoteConfig[]): SshRemoteConfig[];
	onDidChange?(
		key: 'dispatchSettings' | 'sshRemotes',
		callback: (newValue: unknown, oldValue: unknown) => void
	): StoreSubscription;
}

interface AgentConfigsData {
	configs: Record<string, Record<string, unknown>>;
}

interface AgentDispatchRuntimeWorkGraphStore
	extends AgentDispatchWorkGraphStore, HeartbeatWorkGraphStore, ManualOverrideWorkGraphStore {
	listItems?(filters?: WorkItemFilters): Promise<WorkGraphListResult>;
}

/**
 * Adapter that bridges the canonical WorkGraphStorage (whose claimItem returns
 * Promise<WorkItemClaim>) to the dispatch engine's expectation of a
 * Promise<WorkItem> (with the active claim hydrated on the item).
 */
function adaptWorkGraphForDispatch(storage: WorkGraphStorage): AgentDispatchRuntimeWorkGraphStore {
	return {
		getUnblockedWorkItems: (filters) => storage.getUnblockedWorkItems(filters),
		listItems: (filters) => storage.listItems(filters),
		async claimItem(input: WorkItemClaimInput, actor?: WorkGraphActor): Promise<WorkItem> {
			await storage.claimItem(input, actor);
			const item = await storage.getItem(input.workItemId);
			if (!item) {
				throw new Error(`Work Graph item disappeared after claim: ${input.workItemId}`);
			}
			return item;
		},
		renewClaim: (input) => storage.renewClaim(input),
		releaseClaim: (workItemId: string, options?: { note?: string; actor?: WorkGraphActor }) =>
			storage.releaseClaim(workItemId, options),
	};
}

export interface AgentDispatchRuntimeDependencies {
	getMainWindow: Parameters<typeof publishWorkGraphEvent>[0];
	sessionsStore: ReadStore<{ sessions: StoredSession[] }>;
	settingsStore: SettingsStore;
	agentConfigsStore: ReadStore<AgentConfigsData>;
	getProcessManager: () => (EventEmitter & { getAll(): ManagedProcess[] }) | null;
	workGraph?: AgentDispatchRuntimeWorkGraphStore;
	agentDefinitions?: AgentDefinition[];
	/** Override heartbeat interval in ms. Default: 30 000. */
	heartbeatIntervalMs?: number;
	/**
	 * Optional Auto Run trigger. When provided the executor bridge will prefer
	 * triggering Auto Run / playbook execution over the external runner script
	 * for sessions that have a matching playbook.
	 */
	autoRunTrigger?: AutoRunTrigger;
}

export class AgentDispatchRuntime {
	readonly fleetRegistry: FleetRegistry;
	readonly engine: AgentDispatchEngine;
	readonly heartbeat: ClaimHeartbeat;
	readonly manualOverride: ManualOverride;
	readonly executorBridge: ExecutorBridge;
	private readonly workGraph: AgentDispatchRuntimeWorkGraphStore;
	private readonly agentDefinitions: AgentDefinition[];
	private readonly cleanup: StoreSubscription[] = [];
	private refreshQueued = false;
	private started = false;

	constructor(private readonly deps: AgentDispatchRuntimeDependencies) {
		this.workGraph = deps.workGraph ?? adaptWorkGraphForDispatch(getWorkGraphItemStore());
		this.agentDefinitions = deps.agentDefinitions ?? AGENT_DEFINITIONS;
		this.fleetRegistry = new FleetRegistry({
			publishWorkGraphEvent: (operation, payload) =>
				publishWorkGraphEvent(this.deps.getMainWindow, operation, payload),
		});
		this.executorBridge = createExecutorBridge({
			sshStore: createSshRemoteStoreAdapter(deps.settingsStore),
			autoRunTrigger: deps.autoRunTrigger,
		});
		this.engine = new AgentDispatchEngine({
			workGraph: this.workGraph,
			fleetRegistry: this.fleetRegistry,
			executeClaim: (execution) => this.executorBridge.execute(execution),
		});
		this.heartbeat = new ClaimHeartbeat({
			workGraph: this.workGraph,
			fleetRegistry: this.fleetRegistry,
			intervalMs: deps.heartbeatIntervalMs,
		});
		this.manualOverride = new ManualOverride(this.workGraph, this.fleetRegistry);
	}

	start(): void {
		if (this.started) {
			return;
		}
		this.started = true;

		this.cleanup.push(this.engine.bindFleetRegistry());
		this.cleanup.push(
			subscribeWorkGraphEvents((event) => {
				void this.refreshFleet();
				this.engine.handleWorkGraphEvent(event);
			})
		);
		this.subscribeStore('sessions', this.deps.sessionsStore);
		this.subscribeStore('configs', this.deps.agentConfigsStore);
		this.subscribeSettings('dispatchSettings');
		this.subscribeSettings('sshRemotes');
		this.subscribeProcessManager();
		this.heartbeat.start();
		this.cleanup.push(() => this.heartbeat.stop());
		void this.refreshFleet();
	}

	stop(): void {
		while (this.cleanup.length > 0) {
			this.cleanup.pop()?.();
		}
		this.started = false;
	}

	async refreshFleet(): Promise<void> {
		if (this.refreshQueued) {
			return;
		}
		this.refreshQueued = true;

		try {
			const activeClaims = await this.getActiveClaims();
			this.fleetRegistry.refresh({
				sessions: this.deps.sessionsStore.get('sessions', []),
				processes: this.deps.getProcessManager()?.getAll() ?? [],
				agentDefinitions: this.agentDefinitions,
				dispatchProfiles: this.getDispatchProfiles(),
				dispatchSettings: normalizeDispatchSettings(
					this.deps.settingsStore.get('dispatchSettings', DEFAULT_AGENT_DISPATCH_SETTINGS)
				),
				sshRemotes: this.deps.settingsStore.get('sshRemotes', []),
				activeClaims,
			});
		} catch (error) {
			logger.warn('Failed to refresh Agent Dispatch fleet registry', 'AgentDispatch', {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.refreshQueued = false;
		}
	}

	private subscribeStore<T>(key: keyof T, store: ReadStore<T>): void {
		const unsubscribe = store.onDidChange?.(key, () => {
			void this.refreshFleet();
		});
		if (unsubscribe) {
			this.cleanup.push(unsubscribe);
		}
	}

	private subscribeSettings(key: 'dispatchSettings' | 'sshRemotes'): void {
		const unsubscribe = this.deps.settingsStore.onDidChange?.(key, () => {
			void this.refreshFleet();
		});
		if (unsubscribe) {
			this.cleanup.push(unsubscribe);
		}
	}

	private subscribeProcessManager(): void {
		const processManager = this.deps.getProcessManager();
		if (!processManager) {
			return;
		}

		const refresh = () => {
			void this.refreshFleet();
		};
		processManager.on('exit', refresh);
		processManager.on('session-id', refresh);
		processManager.on('agent-error', refresh);
		this.cleanup.push(() => {
			processManager.off('exit', refresh);
			processManager.off('session-id', refresh);
			processManager.off('agent-error', refresh);
		});
	}

	private getDispatchProfiles(): Record<string, AgentDispatchProfile> {
		const configs = this.deps.agentConfigsStore.get('configs', {});
		const profiles: Record<string, AgentDispatchProfile> = {};
		for (const definition of this.agentDefinitions) {
			profiles[definition.id] = normalizeDispatchProfile(
				definition.dispatchSuggestedDefaults,
				configs[definition.id]?.[AGENT_DISPATCH_PROFILE_CONFIG_KEY]
			);
		}
		return profiles;
	}

	private async getActiveClaims(): Promise<WorkItemClaim[]> {
		if (!this.workGraph.listItems) {
			return [];
		}
		const result = await this.workGraph.listItems({
			statuses: ['claimed', 'in_progress', 'review'],
		});
		return result.items.flatMap((item) => (item.claim?.status === 'active' ? [item.claim] : []));
	}
}

let runtime: AgentDispatchRuntime | null = null;

export function startAgentDispatchRuntime(
	deps: AgentDispatchRuntimeDependencies
): AgentDispatchRuntime {
	if (!runtime) {
		runtime = new AgentDispatchRuntime(deps);
		runtime.start();
	}
	return runtime;
}

export function stopAgentDispatchRuntime(): void {
	runtime?.stop();
	runtime = null;
}

function normalizeDispatchSettings(value: unknown): AgentDispatchSettings {
	const stored =
		value && typeof value === 'object' ? (value as Partial<AgentDispatchSettings>) : {};
	return {
		globalAutoPickupEnabled: stored.globalAutoPickupEnabled === true,
		projectAutoPickupEnabled:
			stored.projectAutoPickupEnabled && typeof stored.projectAutoPickupEnabled === 'object'
				? { ...stored.projectAutoPickupEnabled }
				: {},
		sshRemoteAutoPickupEnabled:
			stored.sshRemoteAutoPickupEnabled && typeof stored.sshRemoteAutoPickupEnabled === 'object'
				? { ...stored.sshRemoteAutoPickupEnabled }
				: {},
	};
}

function normalizeDispatchProfile(
	suggestedDefaults: AgentDefinition['dispatchSuggestedDefaults'],
	value: unknown
): AgentDispatchProfile {
	const stored = value && typeof value === 'object' ? (value as Partial<AgentDispatchProfile>) : {};
	const maxConcurrentClaims = Number(stored.maxConcurrentClaims);
	const capabilityTags = Array.isArray(stored.capabilityTags)
		? stored.capabilityTags.map((tag) => String(tag).trim()).filter(Boolean)
		: (suggestedDefaults?.capabilityTags ?? DEFAULT_AGENT_DISPATCH_PROFILE.capabilityTags);

	return {
		autoPickupEnabled: stored.autoPickupEnabled === true,
		capabilityTags,
		maxConcurrentClaims:
			Number.isFinite(maxConcurrentClaims) && maxConcurrentClaims > 0
				? Math.floor(maxConcurrentClaims)
				: (suggestedDefaults?.maxConcurrentClaims ??
					DEFAULT_AGENT_DISPATCH_PROFILE.maxConcurrentClaims),
		...(suggestedDefaults ? { suggestedDefaults } : {}),
	};
}
