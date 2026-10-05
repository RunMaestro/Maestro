/**
 * @file desktop-engine.ts
 * @description The desktop's one group chat engine, and the adapters it is built over.
 *
 * The engine itself lives in the library (`src/shared/maestro-lib/groupchat/router.ts`)
 * and owns rounds: routing, delegation, synthesis, recovery, watchdogs. It takes
 * everything it reaches outside itself for as an input, and this module answers
 * each one with the desktop's own:
 *
 * | Port        | Desktop answer                                                        |
 * | ----------- | --------------------------------------------------------------------- |
 * | store       | `group-chat-storage` (the Electron root), read at call time           |
 * | events      | `groupChatEmitters`, read at call time (the IPC module fills them)    |
 * | agents      | the six callbacks `ipc/bootstrap` registers, held here                |
 * | prompts     | `getPrompt` from the prompt manager                                   |
 * | power       | `powerManager`                                                        |
 * | metrics     | the sleep-aware instance `group-chat-turn-metrics` builds             |
 * | launcher    | `spawnGroupChatAgent` over a `ProcessManager`, per call               |
 *
 * Every function the main process imports from `group-chat-router.ts`,
 * `group-chat-moderator.ts` and `group-chat-agent.ts` is a one-line binding to the
 * engine built here, so none of their callers change.
 */

import { v4 as uuidv4 } from 'uuid';
import type { AgentDetector } from '../agents';
import { powerManager } from '../power-manager';
import { getPrompt } from '../prompt-manager';
import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';
import { createGroupChatEngine } from '../../shared/maestro-lib/groupchat/router';
import type {
	GroupChatAgentDirectory,
	GroupChatEventSink,
	GroupChatLauncher,
	GroupChatSessionInfo,
	GroupChatTurnRunner,
} from '../../shared/maestro-lib/groupchat/types';
import { groupChatEmitters } from './emitters';
import * as storage from './group-chat-storage';
import { desktopTurnMetrics } from './group-chat-turn-metrics';
import { spawnGroupChatAgent } from './spawnGroupChatAgent';
import { toSpawnGroupChatAgentConfig } from './spawn-config';
import type { IProcessManager } from './group-chat-moderator';

// ---------------------------------------------------------------------------
// The agent directory: six callbacks the main process registers at startup
// ---------------------------------------------------------------------------

/** Callback type for getting available agents from the session store. */
export type GetSessionsCallback = () => GroupChatSessionInfo[];

/** Callback type for getting custom environment variables for an agent. */
export type GetCustomEnvVarsCallback = (agentId: string) => Record<string, string> | undefined;
export type GetAgentConfigCallback = (agentId: string) => Record<string, any> | undefined;
export type GetModeratorSettingsCallback = () => {
	conductorProfile: string;
};

const directoryCallbacks: {
	getSessions: GetSessionsCallback | null;
	getCustomEnvVars: GetCustomEnvVarsCallback | null;
	getAgentConfig: GetAgentConfigCallback | null;
	getModeratorSettings: GetModeratorSettingsCallback | null;
	sshStore: SshRemoteSettingsStore | null;
} = {
	getSessions: null,
	getCustomEnvVars: null,
	getAgentConfig: null,
	getModeratorSettings: null,
	sshStore: null,
};

export function setGetSessionsCallback(callback: GetSessionsCallback): void {
	directoryCallbacks.getSessions = callback;
}

export function setGetCustomEnvVarsCallback(callback: GetCustomEnvVarsCallback): void {
	directoryCallbacks.getCustomEnvVars = callback;
}

export function setGetAgentConfigCallback(callback: GetAgentConfigCallback): void {
	directoryCallbacks.getAgentConfig = callback;
}

export function setGetModeratorSettingsCallback(callback: GetModeratorSettingsCallback): void {
	directoryCallbacks.getModeratorSettings = callback;
}

export function setSshStore(store: SshRemoteSettingsStore): void {
	directoryCallbacks.sshStore = store;
}

const desktopAgentDirectory: GroupChatAgentDirectory = {
	list: () => directoryCallbacks.getSessions?.() ?? [],
	providerConfig: (providerId) => directoryCallbacks.getAgentConfig?.(providerId) || {},
	providerEnvVars: (providerId) => directoryCallbacks.getCustomEnvVars?.(providerId),
	conductorProfile: () => directoryCallbacks.getModeratorSettings?.().conductorProfile ?? '',
	sshStore: () => directoryCallbacks.sshStore,
};

// ---------------------------------------------------------------------------
// Events: read the emitter at call time, so a field assigned later (or replaced by a
// test) is the one that runs
// ---------------------------------------------------------------------------

const desktopEvents: GroupChatEventSink = {
	message: (id, message) => groupChatEmitters.emitMessage?.(id, message),
	stateChange: (id, state) => groupChatEmitters.emitStateChange?.(id, state),
	participantsChanged: (id, participants) =>
		groupChatEmitters.emitParticipantsChanged?.(id, participants),
	moderatorUsage: (id, usage) => groupChatEmitters.emitModeratorUsage?.(id, usage),
	historyEntry: (id, entry) => groupChatEmitters.emitHistoryEntry?.(id, entry),
	participantState: (id, name, state) => groupChatEmitters.emitParticipantState?.(id, name, state),
	moderatorSessionIdChanged: (id, sessionId) =>
		groupChatEmitters.emitModeratorSessionIdChanged?.(id, sessionId),
	autoRunTriggered: (id, name, filename) =>
		groupChatEmitters.emitAutoRunTriggered?.(id, name, filename),
	autoRunBatchComplete: (id, name) => groupChatEmitters.emitAutoRunBatchComplete?.(id, name),
	participantLiveOutput: (id, name, chunk) =>
		groupChatEmitters.emitParticipantLiveOutput?.(id, name, chunk),
};

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * The one engine the desktop runs. Storage functions are bound at call time, not
 * captured, so a module-level mock of the storage module still applies.
 */
export const desktopGroupChatEngine = createGroupChatEngine({
	store: {
		loadGroupChat: (id) => storage.loadGroupChat(id),
		updateGroupChat: (id, updates) => storage.updateGroupChat(id, updates),
		updateParticipant: (id, name, updates) => storage.updateParticipant(id, name, updates),
		addParticipantToChat: (id, participant) => storage.addParticipantToChat(id, participant),
		removeParticipantFromChatWithResult: (id, name) =>
			storage.removeParticipantFromChatWithResult(id, name),
		getParticipant: (id, name) => storage.getParticipant(id, name),
		addGroupChatHistoryEntry: (id, entry) => storage.addGroupChatHistoryEntry(id, entry),
		getGroupChatDir: (id) => storage.getGroupChatDir(id),
	},
	events: desktopEvents,
	agents: desktopAgentDirectory,
	prompts: { get: (id) => getPrompt(id) },
	power: {
		block: (reason) => powerManager.addBlockReason(reason),
		unblock: (reason) => powerManager.removeBlockReason(reason),
	},
	metrics: desktopTurnMetrics,
	newId: uuidv4,
});

// ---------------------------------------------------------------------------
// The launcher: how a turn starts, from the desktop's process manager
// ---------------------------------------------------------------------------

/** A runner over the desktop's process manager: stops a turn by its full id. */
export function createDesktopTurnStopper(
	processManager: Pick<IProcessManager, 'kill'>
): Pick<GroupChatTurnRunner, 'stop'> {
	return {
		stop: (processId) => {
			processManager.kill(processId);
		},
	};
}

/**
 * How the desktop starts a group chat turn: `spawnGroupChatAgent` (SSH wrap, Claude
 * spawn mode, Windows shell) over the process manager, with agents resolved by the
 * detector. Both are required: with either missing there is no launcher, and the
 * engine logs the message and starts nothing.
 */
export function createDesktopGroupChatLauncher(
	processManager: IProcessManager,
	agentDetector: Pick<AgentDetector, 'getAgent'>
): GroupChatLauncher {
	return {
		runner: {
			...createDesktopTurnStopper(processManager),
			start: async (spawn) =>
				spawnGroupChatAgent(
					toSpawnGroupChatAgentConfig(spawn, {
						processManager,
						sshStore: desktopAgentDirectory.sshStore(),
					})
				),
		},
		resolveAgent: (providerId) => agentDetector.getAgent(providerId),
	};
}

/** The launcher for a call that holds both halves, or undefined when either is missing. */
export function desktopLauncherFor(
	processManager: IProcessManager | null | undefined,
	agentDetector: Pick<AgentDetector, 'getAgent'> | null | undefined
): GroupChatLauncher | undefined {
	return processManager && agentDetector
		? createDesktopGroupChatLauncher(processManager, agentDetector)
		: undefined;
}
