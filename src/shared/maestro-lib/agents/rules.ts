/**
 * The pure rules behind the agent, group, and tab commands (gap L1a).
 *
 * The desktop spreads these rules across `useSessionCrud`, `useSessionLifecycle`,
 * `useGroupManagement`, `tabHelpers`, and a drifted duplicate in
 * `useAppRemoteEventListeners`. Here each one is a function of plain data: no
 * store, no IPC, no clock of its own (a `RuleContext` supplies ids, time, and
 * randomness). The repository (`repository.ts`) runs them under a mutation queue;
 * the desktop can call the same functions on its own state (L1b, Phase 9), and
 * the renderer's `validateNewSession` / `validateEditSession` and
 * `withWorkingDirectory` already do.
 *
 * Records are replaced, never mutated: every function returns new objects and
 * leaves its input alone, and keeps every key it was not asked to change
 * (DD-5), so a field this build has never heard of survives.
 */

import { stripBlankEnvVars } from '../../agentEnvironment';
import { isValidAgentId } from '../../agentIds';
import { isSameDirectory, rebasePathOntoRoot } from '../../agentWorkingDirectory';
import { validateGroupAppearance } from '../../groupAppearance';
import { canCreateGroupInside, removeGroupAndPromoteChildren } from '../../groupHierarchy';
import { PLAYBOOKS_DIR } from '../../maestro-paths';
import {
	asThinkingMode,
	type Group,
	type ThinkingMode,
	type ToolType,
	type UsageStats,
} from '../../types';
import { generateUUID } from '../../uuid';
import { addUsageStats } from '../streaming/usage-totals';
import type {
	AgentCreateInput,
	AgentPatch,
	AgentPatchField,
	AgentSshSettings,
	GroupCreateInput,
	TabPatch,
} from '../client/types';
import type {
	AgentRecord,
	AgentSshRecord,
	AITabRecord,
	ClosedTabRecord,
	GroupRecord,
	TabRefRecord,
} from '../store/records';
import type { LogEntryRecord } from '../store/transcript';
import {
	switchAgentProvider,
	updateProviderSlot,
	type ProviderSwitchAgent,
	type ProviderSwitchTab,
} from './providerSwap';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** What a rule needs from outside: ids, the clock, and a random draw. Tests inject fixed ones. */
export interface RuleContext {
	newId(): string;
	now(): number;
	/** `[0, 1)`, like `Math.random`. */
	random(): number;
}

export const DEFAULT_RULE_CONTEXT: RuleContext = {
	newId: generateUUID,
	now: () => Date.now(),
	random: () => Math.random(),
};

/** The settings a new tab starts from (`defaultSaveToHistory`, `defaultShowThinking`, `newTabPlacement`). */
export interface TabDefaults {
	saveToHistory: boolean;
	showThinking: ThinkingMode;
	placement: 'end' | 'after-current';
}

/** The desktop's defaults: save to History, no thinking, a new tab at the end of the strip. */
export const DEFAULT_TAB_DEFAULTS: TabDefaults = {
	saveToHistory: true,
	showThinking: 'off',
	placement: 'end',
};

/** The tab defaults a settings document holds. A key the person never touched reads as the default. */
export function tabDefaultsFromSettings(
	settings: Record<string, unknown> | undefined
): TabDefaults {
	const placement = settings?.newTabPlacement;
	return {
		saveToHistory: settings?.defaultSaveToHistory !== false,
		showThinking:
			asThinkingMode(settings?.defaultShowThinking) ?? DEFAULT_TAB_DEFAULTS.showThinking,
		placement:
			placement === 'end' || placement === 'after-current'
				? placement
				: DEFAULT_TAB_DEFAULTS.placement,
	};
}

/** A rule's failure: a code the caller maps onto `ClientErrorCode`, and text safe to show. */
export type RuleFailure = { ok: false; code: 'invalid' | 'rejected'; message: string };
export type RuleResult<T> = { ok: true; value: T } | RuleFailure;

const invalid = (message: string): RuleFailure => ({ ok: false, code: 'invalid', message });

/**
 * An agent's SSH config, or undefined. A record read from disk is not trusted: a
 * value that is not an object (a hand edit, a build that stored something else) reads
 * as "no SSH config" rather than throwing in a rule.
 */
export function sshRecordOf(value: unknown): AgentSshRecord | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as AgentSshRecord)
		: undefined;
}

// ---------------------------------------------------------------------------
// Names and validation
// ---------------------------------------------------------------------------

export const MAX_AGENT_NAME_LENGTH = 100;

/** An agent name as typed: trimmed, present, and not longer than the Left Bar can hold. */
export function checkAgentName(name: unknown): RuleResult<string> {
	const trimmed = typeof name === 'string' ? name.trim() : '';
	if (!trimmed) return invalid('The agent needs a name.');
	if (trimmed.length > MAX_AGENT_NAME_LENGTH) {
		return invalid(`The name must be ${MAX_AGENT_NAME_LENGTH} characters or fewer.`);
	}
	return { ok: true, value: trimmed };
}

/** What `validateNewAgent` and `validateAgentRename` report. The renderer's `SessionValidationResult`. */
export interface AgentValidationResult {
	valid: boolean;
	error?: string;
	errorField?: 'name' | 'directory';
	/** A directory conflict the person can acknowledge and go on. */
	warning?: string;
	warningField?: 'directory';
	/** Names of the conflicting agents, for display. */
	conflictingAgents?: string[];
}

/** The fields of an existing agent the validators read. A renderer `Session` and an `AgentRecord` both fit. */
export interface ValidatedAgent {
	id: string;
	name: string;
	cwd?: string;
	projectRoot?: string;
	/** Read through `sshRecordOf`; typed `unknown` so an untrusted `AgentRecord` fits. */
	sessionSshRemoteConfig?: unknown;
	sshRemoteId?: unknown;
	sshRemote?: unknown;
}

/** The SSH remote an agent runs on, or null for a local one. */
function sshRemoteIdOf(agent: ValidatedAgent): string | null {
	const config = sshRecordOf(agent.sessionSshRemoteConfig);
	// `sessionSshRemoteConfig` is the canonical per-agent SSH config.
	if (config?.enabled && typeof config.remoteId === 'string' && config.remoteId) {
		return config.remoteId;
	}
	// Fall back to the flattened fields set during the agent lifecycle.
	const flat = typeof agent.sshRemoteId === 'string' ? agent.sshRemoteId : '';
	const nested = (agent.sshRemote as { id?: unknown } | null | undefined)?.id;
	return flat || (typeof nested === 'string' ? nested : '') || null;
}

/** Trailing slashes dropped and case folded, so `/A/b/` and `/a/b` name one directory. */
function comparableDirectory(dir: string): string {
	return dir.replace(/\/+$/, '').toLowerCase();
}

/**
 * Whether a new agent can be created with this name and directory.
 *
 * 1. Names are unique across agents, ignoring case (a hard error).
 * 2. A directory another agent on the SAME host already uses is a warning the
 *    person can acknowledge: two agents in one directory can clobber each
 *    other's work. Agents on different hosts (local, or different SSH remotes)
 *    never conflict.
 */
export function validateNewAgent(
	name: string,
	directory: string,
	existing: readonly ValidatedAgent[],
	sshRemoteId?: string | null
): AgentValidationResult {
	const trimmedName = name.trim();
	const duplicate = existing.find(
		(agent) => agent.name.toLowerCase() === trimmedName.toLowerCase()
	);
	if (duplicate) {
		return {
			valid: false,
			error: `An agent named "${duplicate.name}" already exists`,
			errorField: 'name',
		};
	}

	const wanted = comparableDirectory(directory);
	const remoteId = sshRemoteId || null;
	const conflicting = existing.filter(
		(agent) =>
			comparableDirectory(agent.projectRoot || agent.cwd || '') === wanted &&
			sshRemoteIdOf(agent) === remoteId
	);
	if (conflicting.length > 0) {
		const names = conflicting.map((agent) => agent.name);
		const list = names.length === 1 ? `"${names[0]}"` : names.map((n) => `"${n}"`).join(', ');
		return {
			valid: true,
			warning: `This directory is already used by ${list}. Running multiple agents in the same directory may cause them to clobber each other's work.`,
			warningField: 'directory',
			conflictingAgents: names,
		};
	}
	return { valid: true };
}

/** Whether an agent can take this name: unique across the OTHER agents, ignoring case. */
export function validateAgentRename(
	name: string,
	agentId: string,
	existing: readonly ValidatedAgent[]
): AgentValidationResult {
	const trimmedName = name.trim();
	const duplicate = existing.find(
		(agent) => agent.id !== agentId && agent.name.toLowerCase() === trimmedName.toLowerCase()
	);
	if (duplicate) {
		return {
			valid: false,
			error: `An agent named "${duplicate.name}" already exists`,
			errorField: 'name',
		};
	}
	return { valid: true };
}

/** The create input after its cheap checks: a name, a runnable provider, a directory. */
export interface CheckedCreateInput {
	name: string;
	provider: ToolType;
	cwd: string;
}

/** The checks a client can make without the filesystem. The WebSocket client runs them before it sends. */
export function checkAgentCreateInput(input: AgentCreateInput): RuleResult<CheckedCreateInput> {
	const name = checkAgentName(input.name);
	if (!name.ok) return name;
	const provider = input.provider;
	if (!provider || provider === 'terminal' || !isValidAgentId(provider)) {
		return invalid(`Unknown provider "${provider}".`);
	}
	const cwd = input.cwd?.trim();
	if (!cwd) return invalid('The agent needs a working directory.');
	return { ok: true, value: { name: name.value, provider: provider as ToolType, cwd } };
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/** A fresh AI tab: no provider session yet, the settings defaults, an empty transcript. */
export function buildTabRecord(ctx: RuleContext, defaults: TabDefaults): AITabRecord {
	return {
		id: ctx.newId(),
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: ctx.now(),
		state: 'idle',
		saveToHistory: defaults.saveToHistory,
		showThinking: defaults.showThinking,
	};
}

function countOf(value: unknown): number {
	return Array.isArray(value) ? value.length : 0;
}

/** The index of the tab the person is looking at in `unifiedTabOrder`, by the renderer's precedence. */
function activeOrderIndex(agent: AgentRecord, order: readonly TabRefRecord[]): number {
	const find = (type: string, id: unknown): number =>
		typeof id === 'string' && id
			? order.findIndex((ref) => ref.type === type && ref.id === id)
			: -1;
	if (typeof agent.activeGroupId === 'string' && agent.activeGroupId) {
		const group = find('group', agent.activeGroupId);
		if (group !== -1) return group;
	}
	if (agent.activeTerminalTabId) return find('terminal', agent.activeTerminalTabId);
	if (agent.activeFileTabId) return find('file', agent.activeFileTabId);
	if (agent.activeBrowserTabId) return find('browser', agent.activeBrowserTabId);
	return find('ai', agent.activeTabId);
}

/**
 * Where a new tab's ref goes in `unifiedTabOrder`: at the end, or directly to the
 * right of the tab the person is looking at (`newTabPlacement`). When the active
 * tab cannot be located the ref is appended either way.
 */
export function insertAfterActiveInUnifiedTabOrder(
	agent: AgentRecord,
	ref: TabRefRecord,
	placement: TabDefaults['placement']
): TabRefRecord[] {
	const order = Array.isArray(agent.unifiedTabOrder) ? agent.unifiedTabOrder : [];
	if (placement === 'end') return [...order, ref];
	const active = activeOrderIndex(agent, order);
	if (active === -1) return [...order, ref];
	return [...order.slice(0, active + 1), ref, ...order.slice(active + 1)];
}

/**
 * Add a fresh AI tab. It is inserted by the placement setting and never made the
 * active one: a create from a script must not move what the person is looking at
 * (CO-4), so `activeTabId` and every other active id stay as they were.
 */
export function addTabRecord(
	agent: AgentRecord,
	ctx: RuleContext,
	defaults: TabDefaults
): { agent: AgentRecord; tab: AITabRecord } {
	const tab = buildTabRecord(ctx, defaults);
	const next: AgentRecord = {
		...agent,
		aiTabs: [...(Array.isArray(agent.aiTabs) ? agent.aiTabs : []), tab],
		unifiedTabOrder: insertAfterActiveInUnifiedTabOrder(
			agent,
			{ type: 'ai', id: tab.id },
			defaults.placement
		),
	};
	// An agent that had no AI tab to point at (only non-AI tabs were open) now has one.
	if (!agent.activeTabId) next.activeTabId = tab.id;
	return { agent: next, tab };
}

/** The pairing a consult tab belongs to: which agent, and which of its tabs, asked. */
export interface ConsultTabKey {
	sourceSessionId: string;
	sourceTabId: string;
}

/** The consult tab an agent keeps for `key`, if one exists. A hidden tab is found like any other. */
export function findConsultTabRecord(
	agent: AgentRecord,
	key: ConsultTabKey
): AITabRecord | undefined {
	return agent.aiTabs?.find(
		(tab) =>
			tab.consultOrigin?.sourceSessionId === key.sourceSessionId &&
			tab.consultOrigin?.sourceTabId === key.sourceTabId
	);
}

/** What opening a consult tab writes: who asked, what the tab is called, and the question. */
export interface ConsultTabOpen {
	key: ConsultTabKey;
	/** The tab's label (`↩ <source agent>`), used only when the tab is created. */
	name: string;
	/** The question, as the first (or next) user entry of the consult tab. */
	question: LogEntryRecord;
}

/**
 * Find or create the HIDDEN consult tab for a (source agent, source tab) pairing and append the
 * question to it. A repeat consult from the same pairing reuses the tab, and its captured provider
 * session id comes back so the target resumes it.
 *
 * A consult is background work on the consulted agent, so this changes nothing the person sees
 * there: the tab is hidden (no chip), it is never made the active tab and no other active id moves,
 * and it is not saved to History as a conversation of its own (the consult records its own entry).
 * Its ref still joins `unifiedTabOrder`, which is what restores its place if it is ever revealed.
 */
export function openConsultTabRecord(
	agent: AgentRecord,
	open: ConsultTabOpen,
	ctx: RuleContext,
	defaults: TabDefaults
): { agent: AgentRecord; tab: AITabRecord; resumeAgentSessionId?: string; created: boolean } {
	const existing = findConsultTabRecord(agent, open.key);
	if (existing) {
		const tab = {
			...existing,
			logs: [...(Array.isArray(existing.logs) ? existing.logs : []), open.question],
		};
		return {
			agent: {
				...agent,
				aiTabs: (agent.aiTabs ?? []).map((entry) => (entry.id === tab.id ? tab : entry)),
			},
			tab,
			resumeAgentSessionId: existing.agentSessionId ?? undefined,
			created: false,
		};
	}
	const tab: AITabRecord = {
		...buildTabRecord(ctx, { ...defaults, saveToHistory: false }),
		name: open.name,
		logs: [open.question],
		hidden: true,
		consultOrigin: { ...open.key },
	};
	return {
		agent: {
			...agent,
			aiTabs: [...(Array.isArray(agent.aiTabs) ? agent.aiTabs : []), tab],
			unifiedTabOrder: [
				...(Array.isArray(agent.unifiedTabOrder) ? agent.unifiedTabOrder : []),
				{ type: 'ai', id: tab.id },
			],
		},
		tab,
		created: true,
	};
}

/** What a finished consult writes onto its consult tab. */
export interface ConsultAnswerRecord {
	/** The answer, or the failure with its termination note, as one transcript entry. */
	entry: LogEntryRecord;
	/** The provider the consult ran under, so the resume token lands on that provider's slot. */
	provider: string;
	/** The target's provider session id. Present only for a consult that SUCCEEDED (B18). */
	agentSessionId?: string;
}

/**
 * The consult tab after its answer: the entry appended, and the provider session id stored only
 * when the consult succeeded, so a run that auth, usage or CLI errored is never resumed. The tab's
 * `hasUnread` is never touched: a consult is answered in the background.
 */
export function recordConsultAnswerRecord(
	tab: AITabRecord,
	agent: AgentRecord,
	answer: ConsultAnswerRecord
): AITabRecord {
	const appended: AITabRecord = {
		...tab,
		logs: [...(Array.isArray(tab.logs) ? tab.logs : []), answer.entry],
	};
	return answer.agentSessionId
		? recordTabSession(appended, agent, answer.provider, { agentSessionId: answer.agentSessionId })
		: appended;
}

export interface CloseTabOutcome {
	agent: AgentRecord;
	/** What the archive receives. */
	closed: ClosedTabRecord;
	/** Created because no tab of any kind survived: an agent always has something to type into. */
	freshTab?: AITabRecord;
}

/**
 * Close one AI tab (CH-1). A tab the strip does not draw (a hidden consult tab)
 * is not closable from here and answers `null`, as does an unknown id.
 *
 * - When the closed tab was the active one, `activeTabId` moves to the AI tab to
 *   its left in strip order, or the one that was to its right when it led the strip.
 * - A fresh tab is created only when no tab of ANY kind survives. When only
 *   file, terminal, or browser tabs survive, `activeTabId` becomes `''`.
 * - The file, terminal, and browser active ids and `inputMode` are never touched
 *   (CO-4): the desktop helper may switch the view to a neighbouring terminal
 *   tab, and a script closing a tab must not do that.
 */
export function closeTabRecord(
	agent: AgentRecord,
	tabId: string,
	ctx: RuleContext,
	defaults: TabDefaults
): CloseTabOutcome | null {
	const tabs = Array.isArray(agent.aiTabs) ? agent.aiTabs : [];
	const index = tabs.findIndex((tab) => tab.id === tabId);
	if (index === -1 || tabs[index].hidden === true) return null;

	const closed: ClosedTabRecord = { tab: { ...tabs[index] }, index, closedAt: ctx.now() };
	let aiTabs = tabs.filter((tab) => tab.id !== tabId);
	const visible = aiTabs.filter((tab) => tab.hidden !== true);
	const otherTabs =
		countOf(agent.filePreviewTabs) + countOf(agent.terminalTabs) + countOf(agent.browserTabs);

	let order = (Array.isArray(agent.unifiedTabOrder) ? agent.unifiedTabOrder : []).filter(
		(ref) => !(ref.type === 'ai' && ref.id === tabId)
	);
	let activeTabId = typeof agent.activeTabId === 'string' ? agent.activeTabId : '';
	let freshTab: AITabRecord | undefined;

	if (visible.length === 0 && otherTabs === 0) {
		// Hidden consult tabs stay beside the replacement: they are the person's data.
		freshTab = buildTabRecord(ctx, defaults);
		aiTabs = [...aiTabs, freshTab];
		order = [...order, { type: 'ai', id: freshTab.id }];
		activeTabId = freshTab.id;
	} else if (visible.length === 0) {
		activeTabId = '';
	} else if (activeTabId === tabId) {
		activeTabId = neighbourTabId(agent, tabs, tabId, visible);
	}

	return {
		agent: { ...agent, aiTabs, unifiedTabOrder: order, activeTabId },
		closed,
		...(freshTab ? { freshTab } : {}),
	};
}

/** The AI tab to activate after `closedId` leaves: the chip to its left, or the new first one. */
function neighbourTabId(
	agent: AgentRecord,
	before: readonly AITabRecord[],
	closedId: string,
	survivors: readonly AITabRecord[]
): string {
	const alive = new Set(survivors.map((tab) => tab.id));
	// The strip's order: the `ai` refs of unifiedTabOrder that still name a drawn tab, or the closed one.
	let strip = (Array.isArray(agent.unifiedTabOrder) ? agent.unifiedTabOrder : [])
		.filter((ref) => ref.type === 'ai' && (alive.has(ref.id) || ref.id === closedId))
		.map((ref) => ref.id);
	if (!strip.includes(closedId)) {
		// An order that does not name the tab: fall back to the stored tab order.
		strip = before.filter((tab) => alive.has(tab.id) || tab.id === closedId).map((tab) => tab.id);
	}
	const position = strip.indexOf(closedId);
	const remaining = strip.filter((id) => id !== closedId);
	if (remaining.length === 0) return survivors[0].id;
	return remaining[Math.min(Math.max(0, position - 1), remaining.length - 1)];
}

/**
 * A tab's name from what was typed. An empty name clears it to `null` so the
 * provider session id label shows again; `isGeneratingName` is cleared because a
 * person naming a tab ends any auto-naming in flight.
 */
export function renameTabRecord(tab: AITabRecord, name: string): AITabRecord {
	const trimmed = name.trim();
	return { ...tab, name: trimmed ? trimmed : null, isGeneratingName: false };
}

/** What starting a turn on a tab writes: the message, whose provider owns the turn, and a consumed merge. */
export interface TurnBegin {
	/** The person's message, as it will read in the transcript. Written before the provider runs. */
	userEntry: LogEntryRecord;
	/** The provider the turn was sent under (settings are codified at send). */
	provider: ToolType;
	/** `pendingMergedContext` went into the prompt, so it is spent (PA17). */
	consumedMergedContext: boolean;
}

/**
 * A tab with a turn started on it: the message is in the transcript (so a crash cannot cost the
 * person what they typed), `turnProvider` names who owns the turn's late events, and a merged
 * context the prompt carried is cleared in the same write that sends it.
 */
export function beginTurnRecord(tab: AITabRecord, begin: TurnBegin): AITabRecord {
	const { pendingMergedContext: _spent, ...kept } = tab;
	const base = begin.consumedMergedContext ? kept : tab;
	return {
		...base,
		turnProvider: begin.provider,
		logs: [...(Array.isArray(tab.logs) ? tab.logs : []), begin.userEntry],
	};
}

/** What a provider told the runtime about a tab's conversation. Absent fields are left as they are. */
export interface TabSessionUpdate {
	agentSessionId?: string;
	/** One finished turn's usage, folded into the provider's running total on the tab. */
	addUsage?: UsageStats;
}

/**
 * Record a provider's session id and usage on the slot that provider owns: the live fields when it
 * is the agent's current provider, its parked entry otherwise. A turn that outlives a provider
 * swap must not write its resume token into the new provider's slot (`updateProviderSlot`).
 */
export function recordTabSession(
	tab: AITabRecord,
	agent: AgentRecord,
	owningProvider: string,
	update: TabSessionUpdate
): AITabRecord {
	const fields: Record<string, unknown> = {};
	if (update.agentSessionId !== undefined) fields.agentSessionId = update.agentSessionId;
	if (update.addUsage !== undefined) {
		const slot = (
			owningProvider === agent.toolType
				? tab
				: (tab.providerSessions as Record<string, unknown>)?.[owningProvider]
		) as { usageStats?: UsageStats } | undefined;
		fields.usageStats = addUsageStats(slot?.usageStats, update.addUsage);
	}
	if (Object.keys(fields).length === 0) return tab;
	return updateProviderSlot(
		tab as unknown as ProviderSwitchTab,
		agent as unknown as ProviderSwitchAgent,
		owningProvider as ToolType,
		fields
	) as unknown as AITabRecord;
}

/** The tab fields a client may edit, and the type each accepts. */
export const TAB_EDITABLE_KEYS: Readonly<Record<string, 'boolean' | 'string' | 'thinking'>> = {
	starred: 'boolean',
	hasUnread: 'boolean',
	saveToHistory: 'boolean',
	readOnlyMode: 'boolean',
	enterToSend: 'boolean',
	showThinking: 'thinking',
	customModel: 'string',
	customEffort: 'string',
};

/** The record-keyed form of a `TabPatch`: the keys the tab stores, with `null` still meaning "clear". */
export function buildTabConfigPatch(patch: TabPatch): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (patch.readOnly !== undefined) out.readOnlyMode = patch.readOnly;
	if (patch.thinking !== undefined) out.showThinking = patch.thinking;
	if (patch.model !== undefined) out.customModel = patch.model;
	if (patch.effort !== undefined) out.customEffort = patch.effort;
	if (patch.saveToHistory !== undefined) out.saveToHistory = patch.saveToHistory;
	if (patch.enterToSend !== undefined) out.enterToSend = patch.enterToSend;
	return out;
}

/**
 * Apply a record-keyed patch to a tab. Only the `TAB_EDITABLE_KEYS` are read, and
 * each value must be of the type its key accepts: these land straight in the
 * persisted tab, so a string in `readOnlyMode` or a mistyped thinking mode would be
 * a permanently wrong chip rather than a rejected command. `null` drops the field
 * so the tab inherits again, which is distinct from `false`.
 */
export function applyTabPatch(
	tab: AITabRecord,
	patch: Record<string, unknown>
): RuleResult<AITabRecord> {
	const next: AITabRecord = { ...tab };
	let touched = 0;
	for (const key of Object.keys(patch)) {
		const kind = TAB_EDITABLE_KEYS[key];
		if (!kind) continue;
		const value = patch[key];
		touched += 1;
		if (value === null) {
			delete next[key];
			continue;
		}
		const valid =
			kind === 'boolean'
				? typeof value === 'boolean'
				: kind === 'string'
					? typeof value === 'string'
					: asThinkingMode(value) !== undefined;
		if (!valid) return invalid(`Invalid value for tab field '${key}'.`);
		next[key] = value;
	}
	if (touched === 0) return invalid('No editable tab fields in the patch.');
	return { ok: true, value: next };
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/** Normalize an SSH settings object the way every writer must: `enabled` and `remoteId` are always present. */
function normalizeSsh(ssh: Partial<AgentSshSettings> | AgentSshRecord): AgentSshRecord {
	return {
		...ssh,
		enabled: ssh.enabled ?? false,
		remoteId: ssh.remoteId ?? null,
	};
}

/**
 * Merge a partial SSH patch onto an agent's stored config. The two always-present
 * fields are normalized so the persisted config is well formed even when the patch
 * touched only an optional flag on an agent that never had SSH config.
 */
export function mergeSshPatch(
	existing: AgentSshRecord | undefined,
	patch: Partial<AgentSshSettings>
): AgentSshRecord {
	return normalizeSsh({ ...(existing ?? {}), ...patch });
}

/**
 * A new agent, as the desktop's "new agent" flow writes it: one fresh AI tab, the
 * settings defaults, every path field the directory, the default Auto Run folder.
 * `input` has passed `checkAgentCreateInput`.
 */
export function buildAgentRecord(
	input: AgentCreateInput,
	checked: CheckedCreateInput,
	ctx: RuleContext,
	defaults: TabDefaults
): { agent: AgentRecord; tab: AITabRecord } {
	const tab = buildTabRecord(ctx, defaults);
	const { name, provider, cwd } = checked;
	const env = input.env ? stripBlankEnvVars(input.env) : undefined;
	const effort = input.effort?.trim();
	const ssh = input.ssh ? normalizeSsh(input.ssh) : undefined;
	const now = ctx.now();

	const agent: AgentRecord = {
		id: ctx.newId(),
		name,
		toolType: provider,
		state: 'idle',
		cwd,
		fullPath: cwd,
		projectRoot: cwd,
		createdAt: now,
		isGitRepo: false,
		aiLogs: [],
		shellLogs: [
			{ id: ctx.newId(), timestamp: now, source: 'system', text: 'Shell Session Ready.' },
		],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 3000 + Math.floor(ctx.random() * 100),
		isLive: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		fileTreeAutoRefreshInterval: 180,
		shellCwd: cwd,
		aiCommandHistory: [],
		shellCommandHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [tab],
		activeTabId: tab.id,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		browserTabs: [],
		activeBrowserTabId: null,
		terminalTabs: [],
		activeTerminalTabId: null,
		unifiedTabOrder: [{ type: 'ai', id: tab.id }],
		unifiedClosedTabHistory: [],
		tabGroups: [],
		activeGroupId: null,
		autoRunFolderPath: input.autoRunFolderPath?.trim() || `${cwd}/${PLAYBOOKS_DIR}`,
	};
	if (input.groupId) agent.groupId = input.groupId;
	if (input.nudgeMessage) agent.nudgeMessage = input.nudgeMessage;
	if (input.newSessionMessage) agent.newSessionMessage = input.newSessionMessage;
	if (input.customPath) agent.customPath = input.customPath;
	if (input.customArgs) agent.customArgs = input.customArgs;
	if (env && Object.keys(env).length > 0) agent.customEnvVars = env;
	if (input.model) agent.customModel = input.model;
	if (effort) agent.customEffort = effort;
	if (input.contextWindow) {
		agent.customContextWindow = input.contextWindow;
		agent.contextWindowSource = 'user-edited';
	}
	if (ssh) agent.sessionSshRemoteConfig = ssh;
	if (provider === 'claude-code') {
		agent.claudeInteractive = { mode: 'api', modeReason: 'auto' };
	}
	return { agent, tab };
}

/**
 * The agent-level fields a record-keyed config patch may write: the Edit Agent
 * fields, plus the UI state a person would otherwise toggle in the Left Bar.
 * Anything else in a patch is ignored, so a client cannot write arbitrary
 * internals.
 */
export const AGENT_EDITABLE_KEYS: ReadonlySet<string> = new Set([
	'nudgeMessage',
	'newSessionMessage',
	'customPath',
	'customArgs',
	'customEnvVars',
	'customModel',
	'customEffort',
	'customContextWindow',
	// Provenance of the window above. Without it a deliberate edit is silently outranked by the provider's report.
	'contextWindowSource',
	'enableMaestroP',
	'maestroPMode',
	'maestroPPath',
	'bookmarked',
]);

/** The record-keyed form of an `AgentPatch`'s config fields, and the `AgentPatchField`s it carries. */
export function buildAgentConfigPatch(patch: AgentPatch): {
	fields: AgentPatchField[];
	patch: Record<string, unknown>;
} {
	const fields: AgentPatchField[] = [];
	const out: Record<string, unknown> = {};
	const put = (field: AgentPatchField, key: string, value: unknown): void => {
		fields.push(field);
		out[key] = value;
	};
	if (patch.model !== undefined) put('model', 'customModel', patch.model);
	if (patch.effort !== undefined) put('effort', 'customEffort', patch.effort);
	if (patch.contextWindow !== undefined) {
		fields.push('contextWindow');
		out.customContextWindow = patch.contextWindow;
		out.contextWindowSource = patch.contextWindow === null ? null : 'user-edited';
	}
	if (patch.customPath !== undefined) put('customPath', 'customPath', patch.customPath);
	if (patch.customArgs !== undefined) put('customArgs', 'customArgs', patch.customArgs);
	if (patch.env !== undefined) {
		put('env', 'customEnvVars', patch.env === null ? null : stripBlankEnvVars(patch.env));
	}
	if (patch.nudgeMessage !== undefined) put('nudgeMessage', 'nudgeMessage', patch.nudgeMessage);
	if (patch.newSessionMessage !== undefined) {
		put('newSessionMessage', 'newSessionMessage', patch.newSessionMessage);
	}
	if (patch.bookmarked !== undefined) put('bookmarked', 'bookmarked', patch.bookmarked);
	return { fields, patch: out };
}

/**
 * Apply a record-keyed config patch. A `null` value clears the field; anything
 * else is written as is. Clearing the context window clears its provenance too:
 * otherwise a stale `user-edited` outlives the value it described and the next
 * window set without provenance inherits a precedence nobody asked for. A blank
 * `customEffort` clears, since an effort of whitespace names no effort.
 */
export function applyAgentConfigPatch(
	agent: AgentRecord,
	patch: Record<string, unknown>
): RuleResult<AgentRecord> {
	const next: AgentRecord = { ...agent };
	let touched = 0;
	for (const key of Object.keys(patch)) {
		if (!AGENT_EDITABLE_KEYS.has(key)) continue;
		touched += 1;
		let value = patch[key];
		if (key === 'customEffort' && typeof value === 'string') value = value.trim() || null;
		if (value === null) delete next[key];
		else next[key] = value;
	}
	if (touched === 0) return invalid('No editable config fields in the patch.');
	if (patch.customContextWindow === null) delete next.contextWindowSource;
	return { ok: true, value: next };
}

/** The fields `relocateAgentPaths` reads and writes. */
export interface RelocatableAgent {
	cwd?: string;
	fullPath?: string;
	shellCwd?: string;
	projectRoot?: string;
	autoRunFolderPath?: string;
	sessionSshRemoteConfig?: unknown;
}

/**
 * Move an agent to `newDir`: `cwd`, `fullPath`, `shellCwd`, `projectRoot`, an Auto
 * Run folder that lived under the old root, and over SSH the remote working
 * directory, all together. Moving `cwd` alone leaves the Files panel listing one
 * folder while the agent runs in another (#1565).
 *
 * Returns the agent itself when `newDir` is blank or every field that says where
 * the agent lives already names it. `shellCwd` is not compared, because a `cd` in
 * the command terminal moves it on purpose. State that described the OLD
 * directory (a remote cwd the agent last reported, git refs, changed files) is
 * cleared; the desktop renderer clears its file tree caches on top of this.
 */
export function relocateAgentPaths<A extends RelocatableAgent>(agent: A, newDir: string): A {
	const dir = newDir.trim();
	if (!dir) return agent;

	const oldRoot = agent.projectRoot || agent.cwd || '';
	const ssh = sshRecordOf(agent.sessionSshRemoteConfig);
	const alreadyThere =
		isSameDirectory(oldRoot, dir) &&
		isSameDirectory(agent.cwd, dir) &&
		isSameDirectory(agent.fullPath, dir) &&
		(!ssh?.enabled || !ssh.workingDirOverride || isSameDirectory(ssh.workingDirOverride, dir));
	if (alreadyThere) return agent;

	return {
		...agent,
		cwd: dir,
		fullPath: dir,
		shellCwd: dir,
		projectRoot: dir,
		autoRunFolderPath: agent.autoRunFolderPath
			? rebasePathOntoRoot(agent.autoRunFolderPath, oldRoot, dir)
			: agent.autoRunFolderPath,
		// Over SSH the remote spawn cwd is read from the override, so it moves too.
		sessionSshRemoteConfig: ssh?.enabled
			? { ...ssh, workingDirOverride: dir }
			: agent.sessionSshRemoteConfig,
		remoteCwd: undefined,
		changedFiles: [],
		isGitRepo: false,
		gitBranches: undefined,
		gitTags: undefined,
		gitRefsCacheTime: undefined,
	};
}

/** What a provider switch hands back: the agent, and what it could not park, one line each. */
export interface ProviderSwitchOutcome {
	agent: AgentRecord;
	notices: string[];
}

/** Switch an agent's provider through the library's one implementation (PS-5). Nothing is dropped. */
export function switchAgentRecordProvider(
	agent: AgentRecord,
	provider: string
): ProviderSwitchOutcome {
	const { agent: switched, unparked } = switchAgentProvider(
		agent as unknown as ProviderSwitchAgent,
		provider as ToolType
	);
	return {
		agent: switched as unknown as AgentRecord,
		notices: unparked.map((item) => item.message),
	};
}

/**
 * The agent that is active after `removedId` leaves: unchanged unless it was the
 * removed one, then the first survivor in stored order, or `''` when none survive.
 * A pointer naming some other agent is left alone (CO-4).
 */
export function activeAgentAfterRemoval(
	survivors: readonly { id: string }[],
	removedId: string,
	activeAgentId: string | undefined
): string | undefined {
	if (activeAgentId !== removedId) return activeAgentId;
	return survivors[0]?.id ?? '';
}

/** Worktree children (`parentSessionId`) travel with their parent when it changes group. */
export function agentsMovingWithParent(
	agents: readonly AgentRecord[],
	agentId: string
): Set<string> {
	const ids = new Set<string>([agentId]);
	for (const agent of agents) {
		if (agent.parentSessionId === agentId) ids.add(agent.id);
	}
	return ids;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/** A group name as the Left Bar shows it: trimmed and upper-cased. `null` when nothing is left. */
export function normalizeGroupName(name: unknown): string | null {
	const trimmed = typeof name === 'string' ? name.trim() : '';
	return trimmed ? trimmed.toUpperCase() : null;
}

/** The default group emoji, a folder. */
export const DEFAULT_GROUP_EMOJI = '\u{1F4C2}';

/**
 * A new user group. The parent must be a root group (one level of nesting), the
 * appearance is validated before anything is built, and the id is `group-<id>`.
 */
export function buildGroupRecord(
	input: GroupCreateInput,
	existing: readonly GroupRecord[],
	ctx: RuleContext
): RuleResult<GroupRecord> {
	const name = normalizeGroupName(input.name);
	if (!name) return invalid('The group needs a name.');
	const parent = input.parentGroupId || undefined;
	if (!canCreateGroupInside(existing as unknown as Group[], parent)) {
		return invalid('A group can only be created inside a top-level group.');
	}
	const appearance = validateGroupAppearance({ emoji: input.emoji });
	if (!appearance.ok) return invalid(appearance.error);
	return {
		ok: true,
		value: {
			id: `group-${ctx.newId()}`,
			name,
			emoji: appearance.value.emoji || DEFAULT_GROUP_EMOJI,
			kind: 'user',
			...(parent ? { parentGroupId: parent } : {}),
			collapsed: false,
		},
	};
}

/**
 * The groups after `groupId` leaves: its child groups move up a level, and no
 * agent is touched. A group the removal did not change is returned as is (same
 * object, same keys), and a promoted child drops its `parentGroupId` key rather
 * than carrying an undefined one.
 */
export function groupsWithout(groups: readonly GroupRecord[], groupId: string): GroupRecord[] {
	const original = new Map(groups.map((group) => [group.id, group]));
	return removeGroupAndPromoteChildren(groups as unknown as Group[], groupId).map((group) => {
		const before = original.get(group.id)!;
		if (before.parentGroupId !== groupId) return before;
		const { parentGroupId: _promoted, ...rest } = before;
		return rest;
	});
}
