/**
 * What a Federation lift moves, and whether it may run at all.
 *
 * A lift hands an SSH agent to the `maestro-cli host` on its remote. The provider already ran on
 * that box as the SSH user, so its session files are there: the host gets an agent with the same
 * working directory (the REMOTE one, not the local placeholder in `cwd`), provider, model, effort
 * and arguments, plus every visible tab with its transcript and the SAME provider session id, so
 * the next turn resumes. Queued messages move with it.
 *
 * This module is the one rule both callers share (`maestro-cli lift` now, the desktop Lift action
 * later): {@link liftRefusal} says why an agent cannot be lifted, {@link planAgentLift} builds the
 * `import_agent` payload and the summary a person reads before anything moves, and
 * `liftBusyReason()` (in `lift-pointer.ts`, so the renderer can import it) is the "no running turn"
 * check.
 *
 * Pure. The reachability of the host and the opt-in of the remote are checked by the caller, which
 * owns the connection.
 */

import { asThinkingMode, type SshRemoteConfig, type UsageStats } from '../../types';
import { isPathAtOrUnderRoot } from '../../worktreePaths';
import type { AgentImportInput, AgentImportQueuedMessage, AgentImportTab } from '../client/types';
import { aiTabsOf, visibleAiTabsOf } from '../store/read-stores';
import type { AgentRecord, AITabRecord } from '../store/records';
import { transcriptOf } from '../store/transcript';
import { liftBusyReason, peerAgentRef, readLiftedTo } from './lift-pointer';
import { planLiftEnv, type SessionDirSelector } from './lift-env';
import { sshRecordOf } from './rules';

/** Why an agent cannot be lifted. Stable: `--json` reports it as `LIFT_<CODE>`. */
export type LiftRefusalCode =
	/** The agent already moved; its pointer names where. */
	| 'already-lifted'
	/** The agent runs on this machine, so its provider sessions are not on any host. */
	| 'not-ssh'
	/** The agent names an SSH remote that is not configured here any more. */
	| 'remote-missing'
	/** A tab is running a turn. A running turn cannot move. */
	| 'busy'
	/** The agent has no AI tab to move. */
	| 'no-tabs';

export interface LiftRefusal {
	code: LiftRefusalCode;
	message: string;
}

/** The SSH remote an agent's turns run on, or undefined for a local agent. */
export function liftSshRemoteId(agent: AgentRecord): string | undefined {
	const ssh = sshRecordOf(agent.sessionSshRemoteConfig);
	return ssh?.enabled && typeof ssh.remoteId === 'string' && ssh.remoteId
		? ssh.remoteId
		: undefined;
}

/**
 * The directory the agent's provider runs in on the remote: the SSH override, else `cwd` (an agent
 * created on the remote's path keeps it in `cwd`). The same rule `buildDuplicateAgentInput()` uses.
 */
export function liftRemoteCwd(agent: AgentRecord): string {
	const ssh = sshRecordOf(agent.sessionSshRemoteConfig);
	const override =
		ssh?.enabled && typeof ssh.workingDirOverride === 'string' ? ssh.workingDirOverride.trim() : '';
	return override || (agent.cwd ?? '').trim();
}

/**
 * The first reason the agent cannot be lifted, from its record alone, or null. Checked in the
 * order a person fixes them. `remotes` is this machine's SSH remote list.
 */
export function liftRefusal(
	agent: AgentRecord,
	remotes: readonly SshRemoteConfig[]
): LiftRefusal | null {
	const pointer = readLiftedTo(agent.liftedTo);
	if (pointer) {
		return {
			code: 'already-lifted',
			message: `"${agent.name}" was already lifted to peer "${pointer.peer}". Send to ${peerAgentRef(pointer.peer, pointer.agentId)} instead.`,
		};
	}
	const remoteId = liftSshRemoteId(agent);
	if (!remoteId) {
		return {
			code: 'not-ssh',
			message: `"${agent.name}" runs on this machine, not on an SSH remote. Only an SSH remote agent can be lifted onto its host.`,
		};
	}
	if (!remotes.some((remote) => remote.id === remoteId)) {
		return {
			code: 'remote-missing',
			message: `"${agent.name}" runs on SSH remote ${remoteId}, which is not configured here. Check it with: maestro-cli list ssh-remotes`,
		};
	}
	const busy = liftBusyReason(agent);
	if (busy) return { code: 'busy', message: busy };
	if (visibleAiTabsOf(agent).length === 0) {
		return { code: 'no-tabs', message: `"${agent.name}" has no AI tab to move.` };
	}
	return null;
}

/** One tab as the plan reports it. The transcript itself rides only in the payload. */
export interface LiftPlanTab {
	id: string;
	name: string | null;
	/** The provider session the host resumes, or null for a tab that never sent a turn. */
	agentSessionId: string | null;
	/** Transcript entries that move. */
	entries: number;
}

/** Something that stays on this machine, and why. */
export interface LiftPlanStay {
	kind: 'secret-env' | 'queued-command' | 'queued-image' | 'hidden-tab' | 'auto-run-folder';
	/** The env key, queue item id, or tab id. */
	ref: string;
	reason: string;
}

/** What a lift sends and keeps. Holds no env value and no transcript text: safe to print. */
export interface LiftPlanSummary {
	agent: { id: string; name: string; provider: string };
	peer: string;
	remote: { id: string; name: string };
	/** The working directory on the host: the agent's remote cwd. */
	cwd: string;
	model?: string;
	effort?: string;
	customArgs?: string;
	customPath?: string;
	env: {
		/** Every key sent, sorted. Values are never shown. */
		sent: string[];
		/** Secret keys sent because `--with-env` was given. */
		secretsSent: string[];
		/** Secret keys kept here because `--with-env` was not given. */
		withheld: string[];
		/** The provider's session-dir selector: always sent, and the host checks the dir exists. */
		sessionDir?: SessionDirSelector;
	};
	tabs: LiftPlanTab[];
	activeTabId?: string;
	/** Queued messages that move, by queue item id, in queue order. */
	queued: string[];
	stays: LiftPlanStay[];
}

export interface LiftPlan {
	summary: LiftPlanSummary;
	/** What `import_agent` receives. */
	input: AgentImportInput;
	/** The local queue items that moved, so the caller can take them off this machine's queue. */
	movedQueueItemIds: string[];
}

export interface PlanAgentLiftInput {
	agent: AgentRecord;
	remote: SshRemoteConfig;
	/** The peer id the host is addressed by (`peerIdFor()`). */
	peer: string;
	/** The provider-level env (Settings -> Agents), which an agent with no record of its own inherits. */
	providerEnvVars?: Record<string, string>;
	/** Send secret env vars too (`--with-env`). */
	withEnv: boolean;
}

function stringField(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function usageStatsOf(value: unknown): UsageStats | undefined {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as UsageStats)
		: undefined;
}

function importTabOf(tab: AITabRecord): AgentImportTab {
	const showThinking = asThinkingMode(tab.showThinking);
	const usageStats = usageStatsOf(tab.usageStats);
	return {
		id: tab.id,
		...(tab.name !== undefined ? { name: tab.name } : {}),
		...(typeof tab.starred === 'boolean' ? { starred: tab.starred } : {}),
		agentSessionId: stringField(tab.agentSessionId) ?? null,
		...(typeof tab.createdAt === 'number' ? { createdAt: tab.createdAt } : {}),
		...(typeof tab.saveToHistory === 'boolean' ? { saveToHistory: tab.saveToHistory } : {}),
		...(showThinking ? { showThinking } : {}),
		...(typeof tab.readOnlyMode === 'boolean' ? { readOnlyMode: tab.readOnlyMode } : {}),
		...(stringField(tab.customModel) ? { model: tab.customModel } : {}),
		...(stringField(tab.customEffort) ? { effort: tab.customEffort } : {}),
		...(usageStats ? { usageStats } : {}),
		logs: transcriptOf(tab),
	};
}

interface StoredQueueItem {
	id?: unknown;
	tabId?: unknown;
	type?: unknown;
	text?: unknown;
	images?: unknown;
	command?: unknown;
}

/** Queued messages that move, and the queue entries that stay with the reason. */
function planQueue(
	agent: AgentRecord,
	tabIds: ReadonlySet<string>
): { queue: AgentImportQueuedMessage[]; moved: string[]; stays: LiftPlanStay[] } {
	const items = Array.isArray(agent.executionQueue) ? (agent.executionQueue as unknown[]) : [];
	const queue: AgentImportQueuedMessage[] = [];
	const moved: string[] = [];
	const stays: LiftPlanStay[] = [];
	for (const raw of items) {
		if (!raw || typeof raw !== 'object') continue;
		const item = raw as StoredQueueItem;
		const id = typeof item.id === 'string' ? item.id : '';
		if (!id) continue;
		if (item.type !== 'message' || typeof item.text !== 'string') {
			// A slash command is expanded by this machine's command list, which the host does not share.
			const command = typeof item.command === 'string' ? item.command : 'a command';
			stays.push({
				kind: 'queued-command',
				ref: id,
				reason: `Queued ${command} is a command, which only this machine expands.`,
			});
			continue;
		}
		if (typeof item.tabId !== 'string' || !tabIds.has(item.tabId)) {
			stays.push({
				kind: 'queued-command',
				ref: id,
				reason: 'Queued for a tab that does not move.',
			});
			continue;
		}
		const images = Array.isArray(item.images)
			? item.images.filter((image): image is string => typeof image === 'string')
			: [];
		// A stored image reference names this machine's image store: only inline data moves.
		const inline = images.filter((image) => image.startsWith('data:'));
		if (inline.length < images.length) {
			stays.push({
				kind: 'queued-image',
				ref: id,
				reason: `${images.length - inline.length} image(s) on this queued message are in this machine's image store and do not move.`,
			});
		}
		queue.push({
			tabId: item.tabId,
			text: item.text,
			...(inline.length > 0 ? { images: inline } : {}),
		});
		moved.push(id);
	}
	return { queue, moved, stays };
}

/**
 * The payload and the readable plan of a lift. Call it after {@link liftRefusal} returned null.
 * Hidden consult tabs stay: they belong to the consult that opened them, on this machine.
 */
export function planAgentLift(input: PlanAgentLiftInput): LiftPlan {
	const { agent, remote, peer } = input;
	const cwd = liftRemoteCwd(agent);
	const env = planLiftEnv({
		provider: agent.toolType,
		customEnvVars: agent.customEnvVars,
		providerEnvVars: input.providerEnvVars,
		withEnv: input.withEnv,
	});

	const tabs = visibleAiTabsOf(agent);
	const tabIds = new Set(tabs.map((tab) => tab.id));
	const importTabs = tabs.map(importTabOf);
	const activeTabId =
		typeof agent.activeTabId === 'string' && tabIds.has(agent.activeTabId)
			? agent.activeTabId
			: undefined;
	const { queue, moved, stays: queueStays } = planQueue(agent, tabIds);

	const stays: LiftPlanStay[] = env.withheld.map((key) => ({
		kind: 'secret-env' as const,
		ref: key,
		reason: 'Secret. Pass --with-env to send it.',
	}));
	for (const tab of aiTabsOf(agent)) {
		if (tabIds.has(tab.id)) continue;
		stays.push({
			kind: 'hidden-tab',
			ref: tab.id,
			reason: 'A hidden consult tab belongs to the consult that opened it on this machine.',
		});
	}
	stays.push(...queueStays);

	// A playbook folder outside the working directory is a path on the remote the host may not
	// mean the same way; the host's default (`.maestro/playbooks` under cwd) is used instead.
	const autoRunFolder = stringField(agent.autoRunFolderPath);
	const keepAutoRun = autoRunFolder && cwd && isPathAtOrUnderRoot(autoRunFolder, cwd);
	if (autoRunFolder && !keepAutoRun) {
		stays.push({
			kind: 'auto-run-folder',
			ref: autoRunFolder,
			reason: 'Outside the working directory. The host uses .maestro/playbooks under it.',
		});
	}

	const model = stringField(agent.customModel);
	const effort = stringField(agent.customEffort);
	const customArgs = stringField(agent.customArgs);
	const customPath = stringField(agent.customPath);
	const nudgeMessage = stringField(agent.nudgeMessage);
	const newSessionMessage = stringField(agent.newSessionMessage);
	const contextWindow =
		typeof agent.customContextWindow === 'number' && agent.customContextWindow > 0
			? agent.customContextWindow
			: undefined;

	const importInput: AgentImportInput = {
		agent: {
			name: agent.name,
			provider: agent.toolType,
			cwd,
			...(model ? { model } : {}),
			...(effort ? { effort } : {}),
			...(contextWindow ? { contextWindow } : {}),
			...(customPath ? { customPath } : {}),
			...(customArgs ? { customArgs } : {}),
			...(Object.keys(env.send).length > 0 ? { env: env.send } : {}),
			...(keepAutoRun ? { autoRunFolderPath: autoRunFolder } : {}),
			...(nudgeMessage ? { nudgeMessage } : {}),
			...(newSessionMessage ? { newSessionMessage } : {}),
		},
		tabs: importTabs,
		...(activeTabId ? { activeTabId } : {}),
		...(queue.length > 0 ? { queue } : {}),
	};

	const summary: LiftPlanSummary = {
		agent: { id: agent.id, name: agent.name, provider: agent.toolType },
		peer,
		remote: { id: remote.id, name: remote.name },
		cwd,
		...(model ? { model } : {}),
		...(effort ? { effort } : {}),
		...(customArgs ? { customArgs } : {}),
		...(customPath ? { customPath } : {}),
		env: {
			sent: Object.keys(env.send).sort(),
			secretsSent: env.secretsSent,
			withheld: env.withheld,
			...(env.sessionDir ? { sessionDir: env.sessionDir } : {}),
		},
		tabs: importTabs.map((tab) => ({
			id: tab.id,
			name: tab.name ?? null,
			agentSessionId: tab.agentSessionId ?? null,
			entries: tab.logs.length,
		})),
		...(activeTabId ? { activeTabId } : {}),
		queued: moved,
		stays,
	};

	return { summary, input: importInput, movedQueueItemIds: moved };
}
