/**
 * Builds the process-listener dependency object from main/index.ts module
 * state and wires it into the process-listeners module, plus the WakaTime
 * heartbeat listener.
 *
 * Extracted from main/index.ts's setupProcessListeners() (Phase 5
 * refactoring). Named as a sibling to process-listeners/ rather than nested
 * inside it, since process-listeners/index.ts already exports a function
 * literally named setupProcessListeners - nesting this here would create a
 * same-directory import that shadows itself.
 */

import type { ProcessManager } from '../process-manager';
import type { WebServer } from '../web-server';
import type { AgentDetector } from '../agents';
import type { CueEngine } from '../cue/cue-engine';
import type { PluginEventBusImpl } from '../plugins/plugin-event-bus';
import type { SafeSendFn } from '../utils/safe-send';
import type { WakaTimeManager } from '../wakatime-manager';
import type { getSettingsStore } from '../stores';
import { setupProcessListeners } from '../process-listeners';
import { setupWakaTimeListener } from '../process-listeners/wakatime-listener';
import { powerManager } from '../power-manager';
import { groupChatEmitters } from '../ipc/handlers/groupChat';
import {
	routeModeratorResponse,
	routeAgentResponse,
	markParticipantResponded,
	settleGroupChatToIdle,
	spawnModeratorSynthesis,
	getGroupChatReadOnlyState,
	respawnParticipantWithRecovery,
	clearActiveParticipantTaskSession,
	clearModeratorResponseTimeout,
} from '../group-chat/group-chat-router';
import {
	updateParticipant,
	loadGroupChat,
	updateGroupChat,
} from '../group-chat/group-chat-storage';
import { needsSessionRecovery, initiateSessionRecovery } from '../group-chat/session-recovery';
import {
	appendToGroupChatBuffer,
	getGroupChatBufferedOutput,
	clearGroupChatBuffer,
} from '../group-chat/output-buffer';
import { parseParticipantSessionId } from '../group-chat/session-parser';
import { extractTextFromStreamJson } from '../group-chat/output-parser';
import { calculateContextTokens } from '../parsers/usage-aggregator';
import { getStatsDB } from '../stats';
import {
	REGEX_MODERATOR_SESSION,
	REGEX_MODERATOR_SESSION_TIMESTAMP,
	REGEX_AI_SUFFIX,
	REGEX_AI_TAB_ID,
	REGEX_BATCH_SESSION,
	REGEX_SYNOPSIS_SESSION,
	debugLog,
} from '../constants';
import { logger } from '../utils/logger';
import { capabilitySnapshots } from '../agents/capability-snapshot';
import { getAgentDefinition } from '../agents/definitions';
import { DEFAULT_CONTEXT_WINDOWS, FALLBACK_CONTEXT_WINDOW } from '../../shared/agentConstants';
import type { AgentId } from '../../shared/agentIds';

export interface ProcessListenersWiringDependencies {
	getProcessManager: () => ProcessManager | null;
	getWebServer: () => WebServer | null;
	getAgentDetector: () => AgentDetector | null;
	getCueEngine: () => CueEngine | null;
	getPluginEventBus: () => PluginEventBusImpl | null;
	safeSend: SafeSendFn;
	settingsStore: ReturnType<typeof getSettingsStore>;
	wakatimeManager: WakaTimeManager;
}

export function wireProcessListeners(deps: ProcessListenersWiringDependencies): void {
	const processManager = deps.getProcessManager();
	if (!processManager) return;

	setupProcessListeners(processManager, {
		getProcessManager: deps.getProcessManager,
		getWebServer: deps.getWebServer,
		getAgentDetector: deps.getAgentDetector,
		safeSend: deps.safeSend,
		powerManager,
		groupChatEmitters,
		emitPluginEvent: (event) => deps.getPluginEventBus()?.emit(event),
		groupChatRouter: {
			routeModeratorResponse,
			routeAgentResponse,
			markParticipantResponded,
			settleGroupChatToIdle,
			spawnModeratorSynthesis,
			getGroupChatReadOnlyState,
			respawnParticipantWithRecovery,
			clearActiveParticipantTaskSession,
			clearModeratorResponseTimeout,
		},
		groupChatStorage: {
			loadGroupChat,
			updateGroupChat,
			updateParticipant,
		},
		sessionRecovery: {
			needsSessionRecovery,
			initiateSessionRecovery,
		},
		outputBuffer: {
			appendToGroupChatBuffer,
			getGroupChatBufferedOutput,
			clearGroupChatBuffer,
		},
		outputParser: {
			extractTextFromStreamJson,
			parseParticipantSessionId,
		},
		usageAggregator: {
			calculateContextTokens,
		},
		getStatsDB,
		debugLog,
		patterns: {
			REGEX_MODERATOR_SESSION,
			REGEX_MODERATOR_SESSION_TIMESTAMP,
			REGEX_AI_SUFFIX,
			REGEX_AI_TAB_ID,
			REGEX_BATCH_SESSION,
			REGEX_SYNOPSIS_SESSION,
		},
		logger,
		getCueEngine: deps.getCueEngine,
		isCueEnabled: () => {
			const ef = deps.settingsStore.get('encoreFeatures', {}) as Record<string, boolean>;
			return !!ef.maestroCue;
		},
		getSshRemoteByName: (name: string) => {
			const remotes = deps.settingsStore.get('sshRemotes', []);
			return remotes.find((r) => r.name === name) ?? null;
		},
		getAgentContextWindow: (agentId: string) => {
			// Prefer a runtime-discovered context window from the capability
			// snapshot if one was probed. Falls back to the static table and
			// finally to the agent definition's configOption default.
			const snapshot = capabilitySnapshots.get(agentId);
			if (typeof snapshot?.contextWindow === 'number' && snapshot.contextWindow > 0) {
				return snapshot.contextWindow;
			}
			const def = getAgentDefinition(agentId);
			const contextOpt = def?.configOptions?.find((o) => o.key === 'contextWindow');
			const fallbackDefault =
				typeof contextOpt?.default === 'number' ? contextOpt.default : FALLBACK_CONTEXT_WINDOW;
			return DEFAULT_CONTEXT_WINDOWS[agentId as AgentId] ?? fallbackDefault;
		},
	});

	// WakaTime heartbeat listener (query-complete -> heartbeat, exit -> cleanup)
	setupWakaTimeListener(processManager, deps.wakatimeManager, deps.settingsStore);
}
