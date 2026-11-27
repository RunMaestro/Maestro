/**
 * groupLifecycle - run a group's Onboarding and Offboarding prompts.
 *
 * A group may hold a prompt to run when an agent joins it and another to run
 * before one leaves it (`Group.lifecycle`, see `src/shared/groupLifecycle.ts`).
 * This service is the one runner every surface calls:
 *
 * - `startGroupOnboarding(agentId)` from each place an agent or a worktree
 *   agent is created. It queues the prompt and returns; nothing waits on it.
 * - `offboardBeforeRemoval(agentId)` from each place an agent is removed. It
 *   queues the prompt and resolves when the turn finishes, when the hook's time
 *   limit runs out, or when the person presses "Remove now". It never rejects:
 *   a broken hook must not leave an agent that cannot be removed.
 * - `runGroupLifecycleNow(groupId, stage, agentId)` for "Run now on an agent..."
 *   in Group Settings and `maestro-cli run-group-lifecycle`. It ignores whether
 *   the hook is on and which events fire it: a person asked for this run.
 *
 * The prompt goes through the execution queue (`enqueuePromptForTab`), in a tab
 * created for it in the background, so it never races a turn the agent is
 * already running and never moves the person's view.
 */

import type { AITab, Group, QueuedTurnSettings, Session } from '../types';
import {
	GROUP_LIFECYCLE_STAGE_LABELS,
	lifecycleEventName,
	lifecycleHookFor,
	lifecycleTabName,
	lifecycleTriggerFor,
	normalizeGroupLifecycle,
	offboardingTimeoutMs,
	substituteLifecycleVariables,
	type GroupLifecycleHook,
	type GroupLifecycleRunReport,
	type GroupLifecycleStage,
	type GroupLifecycleTrigger,
} from '../../shared/groupLifecycle';
import { isWorktreeGroup } from '../../shared/types';
import { resolveTurnSettings } from '../../shared/autorunTurnSettings';
import { ownModel } from '../../shared/autoModel';
import { humanizeDuration } from '../../shared/duration';
import { useSessionStore, updateSessionWith } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useGroupLifecycleStore } from '../stores/groupLifecycleStore';
import { notifyToast } from '../stores/notificationStore';
import { createTab } from '../utils/tabHelpers';
import { captureQueuedTurnSettings } from '../utils/providerTabSessions';
import { substituteTemplateVariables } from '../utils/templateVariables';
import { getSessionSshRemoteId } from '../utils/sessionHelpers';
import { captureException } from '../utils/sentry';
import { logger } from '../utils/logger';
import { gitService } from './git';
import { enqueuePromptForTab } from './queuedPrompt';

/** What queueing a lifecycle prompt did. */
export type GroupLifecycleRunOutcome =
	| { ok: true; report: GroupLifecycleRunReport; itemId: string }
	| { ok: false; error: string };

/**
 * The group whose lifecycle applies to an agent: the group it sits in. A
 * worktree agent sits in its parent's group (`buildWorktreeSession` copies the
 * id). A worktree group (the legacy 🌳 family) takes no settings, so it has no
 * lifecycle either.
 */
export function lifecycleGroupFor(
	agent: Pick<Session, 'groupId'>,
	groups: readonly Group[]
): Group | undefined {
	if (!agent.groupId) return undefined;
	const group = groups.find((candidate) => candidate.id === agent.groupId);
	return group && !isWorktreeGroup(group) ? group : undefined;
}

/** The branch the prompt's {{GIT_BRANCH}} names. Best effort: blank when git cannot say. */
async function branchOf(agent: Session): Promise<string | undefined> {
	if (agent.worktreeBranch) return agent.worktreeBranch;
	if (!agent.isGitRepo) return undefined;
	try {
		const status = await gitService.getStatus(agent.cwd, getSessionSshRemoteId(agent));
		return status.branch || undefined;
	} catch {
		// A missing branch leaves {{GIT_BRANCH}} blank; it is no reason to skip the hook.
		return undefined;
	}
}

/**
 * The prompt as it is sent. Every general variable describes the agent the
 * event is about, even when another agent runs the prompt.
 */
async function renderLifecyclePrompt(
	hook: GroupLifecycleHook,
	stage: GroupLifecycleStage,
	trigger: GroupLifecycleTrigger,
	subject: Session,
	group: Group
): Promise<string> {
	const parent = subject.parentSessionId
		? useSessionStore.getState().sessions.find((agent) => agent.id === subject.parentSessionId)
		: undefined;
	const withEvent = substituteLifecycleVariables(hook.prompt, {
		event: lifecycleEventName(stage, trigger),
		parentAgentName: parent?.name,
		parentPath: parent?.cwd ?? subject.worktreeParentPath,
	});
	return substituteTemplateVariables(withEvent, {
		session: subject,
		gitBranch: await branchOf(subject),
		groupName: group.name,
		groupId: group.id,
		conductorProfile: useSettingsStore.getState().conductorProfile,
	});
}

/**
 * The model the turn runs on: the running agent's own, or the hook's tier
 * resolved through that agent's tier targets and the harness defaults. A tier
 * whose target cannot be used refuses the run; it never falls back to a
 * different model without saying so.
 */
function lifecycleTurnSettings(
	hook: GroupLifecycleHook,
	runAgent: Session,
	tab: AITab
): { ok: true; settings: QueuedTurnSettings } | { ok: false; error: string } {
	const base = captureQueuedTurnSettings(tab, runAgent);
	if (!hook.tier) return { ok: true, settings: base };
	const resolved = resolveTurnSettings(
		runAgent.toolType,
		{ tier: hook.tier, line: 0 },
		ownModel(base.model),
		base.effort,
		base.routing
	);
	if (resolved.refusal) return { ok: false, error: resolved.refusal.message };
	return {
		ok: true,
		settings: {
			...base,
			model: resolved.model,
			effort: resolved.effort,
			...(resolved.runOn ? { runOn: resolved.runOn } : {}),
		},
	};
}

/** A tab nobody has used yet: a new agent's first tab. */
function isPristineTab(tab: AITab): boolean {
	return (
		tab.logs.length === 0 &&
		!tab.agentSessionId &&
		!tab.inputValue?.trim() &&
		(tab.stagedImages?.length ?? 0) === 0
	);
}

/**
 * The tab the prompt runs in, made in the background. A new agent's Onboarding
 * takes over its untouched first tab (renamed), so the agent does not open with
 * a blank tab beside the one doing the work.
 */
function prepareLifecycleTab(
	runAgentId: string,
	tabName: string,
	reusePristineOnlyTab: boolean
): string | null {
	const { defaultSaveToHistory, defaultShowThinking } = useSettingsStore.getState();
	let tabId: string | null = null;
	updateSessionWith(runAgentId, (agent) => {
		const only = agent.aiTabs.length === 1 ? agent.aiTabs[0] : undefined;
		if (reusePristineOnlyTab && only && isPristineTab(only)) {
			tabId = only.id;
			return {
				...agent,
				aiTabs: agent.aiTabs.map((tab) => (tab.id === only.id ? { ...tab, name: tabName } : tab)),
			};
		}
		const created = createTab(agent, {
			name: tabName,
			saveToHistory: defaultSaveToHistory,
			showThinking: defaultShowThinking,
			activate: false,
		});
		if (!created) return agent;
		tabId = created.tab.id;
		return created.session;
	});
	return tabId;
}

/** Queue one stage's prompt for one agent. Shared by every entry point below. */
async function queueLifecyclePrompt(options: {
	group: Group;
	hook: GroupLifecycleHook;
	stage: GroupLifecycleStage;
	subject: Session;
}): Promise<GroupLifecycleRunOutcome> {
	const { group, hook, stage, subject } = options;
	const label = GROUP_LIFECYCLE_STAGE_LABELS[stage];
	const trigger = lifecycleTriggerFor(subject);
	const runAgentId = hook.runsInAgentId ?? subject.id;
	const runAgent = useSessionStore.getState().sessions.find((agent) => agent.id === runAgentId);
	if (!runAgent) {
		return {
			ok: false,
			error: `${label} runs in an agent that no longer exists. Choose another in Group Settings.`,
		};
	}
	if (runAgent.toolType === 'terminal') {
		return {
			ok: false,
			error: `${label} runs in "${runAgent.name}", a terminal, which takes no prompt.`,
		};
	}

	const prompt = await renderLifecyclePrompt(hook, stage, trigger, subject, group);
	const tabName = lifecycleTabName(hook, stage);
	const tabId = prepareLifecycleTab(
		runAgentId,
		tabName,
		stage === 'onboarding' && runAgentId === subject.id
	);
	const live = useSessionStore.getState().sessions.find((agent) => agent.id === runAgentId);
	const tab = live?.aiTabs.find((candidate) => candidate.id === tabId);
	if (!live || !tabId || !tab) {
		return { ok: false, error: `Could not open a tab in "${runAgent.name}" for ${label}.` };
	}

	const turn = lifecycleTurnSettings(hook, live, tab);
	if (!turn.ok) return { ok: false, error: `${label}: ${turn.error}` };

	const item = enqueuePromptForTab({
		sessionId: runAgentId,
		tabId,
		text: prompt,
		turnSettings: turn.settings,
	});
	if (!item)
		return { ok: false, error: `Could not queue the ${label} prompt in "${runAgent.name}".` };

	logger.info(`[groupLifecycle] queued ${stage} for ${subject.id} in ${runAgentId}/${tabId}`);
	return {
		ok: true,
		itemId: item.id,
		report: { stage, subjectAgentId: subject.id, runAgentId, tabId, tabName },
	};
}

/** The agent and its group's hook for `stage`, when the event should fire one. */
function firingHook(
	agentId: string,
	stage: GroupLifecycleStage
): { subject: Session; group: Group; hook: GroupLifecycleHook } | null {
	const { sessions, groups } = useSessionStore.getState();
	const subject = sessions.find((agent) => agent.id === agentId);
	if (!subject) return null;
	const group = lifecycleGroupFor(subject, groups);
	const hook = lifecycleHookFor(group, stage, lifecycleTriggerFor(subject));
	return group && hook ? { subject, group, hook } : null;
}

// ============================================================================
// Onboarding
// ============================================================================

/**
 * Run the group's Onboarding for an agent that was just created in it. Call it
 * after the agent is in the store. Returns at once; a failure is a toast, never
 * a thrown error, because the agent itself was created fine.
 */
export function startGroupOnboarding(agentId: string): void {
	const firing = firingHook(agentId, 'onboarding');
	if (!firing) return;
	void queueLifecyclePrompt({ ...firing, stage: 'onboarding' })
		.then((outcome) => {
			if (outcome.ok) {
				notifyToast({
					type: 'info',
					title: 'Onboarding Started',
					message: `"${firing.group.name}" Onboarding is running for ${firing.subject.name} in tab "${outcome.report.tabName}".`,
				});
				return;
			}
			notifyToast({ type: 'warning', title: 'Onboarding Did Not Run', message: outcome.error });
		})
		.catch((error) => {
			captureException(error, { extra: { agentId, operation: 'group-onboarding' } });
			notifyToast({
				type: 'warning',
				title: 'Onboarding Did Not Run',
				message: error instanceof Error ? error.message : String(error),
			});
		});
}

// ============================================================================
// Offboarding
// ============================================================================

type OffboardingWait = 'finished' | 'timeout' | 'skipped' | 'failed' | 'gone';

/** Removals in flight, so a second request for the same agent waits on the first. */
const inFlight = new Map<string, Promise<void>>();
/** Ends one agent's wait early. Set while the wait runs. */
const skipWaiters = new Map<string, () => void>();

/** "Remove now, skip Offboarding": the removal goes ahead without waiting. */
export function skipOffboarding(subjectAgentId: string): void {
	skipWaiters.get(subjectAgentId)?.();
}

/**
 * Resolve when the queued item has run: it left the queue and its tab is no
 * longer busy. A dispatch failure parks the item in the queue paused, which is
 * `failed`. The agent or the tab going away is `gone`.
 */
function waitForQueuedTurn(
	runAgentId: string,
	tabId: string,
	itemId: string,
	timeoutMs: number,
	subjectAgentId: string
): Promise<OffboardingWait> {
	return new Promise((resolve) => {
		let settled = false;
		let unsubscribe: () => void = () => {};
		const finish = (result: OffboardingWait) => {
			if (settled) return;
			settled = true;
			unsubscribe();
			clearTimeout(timer);
			skipWaiters.delete(subjectAgentId);
			resolve(result);
		};
		const check = (state: { sessions: Session[] }) => {
			const agent = state.sessions.find((candidate) => candidate.id === runAgentId);
			if (!agent) return finish('gone');
			const queued = agent.executionQueue?.find((item) => item.id === itemId);
			if (queued) {
				if (queued.paused) finish('failed');
				return;
			}
			const tab = agent.aiTabs.find((candidate) => candidate.id === tabId);
			if (!tab) return finish('gone');
			if (tab.state !== 'busy') finish('finished');
		};
		skipWaiters.set(subjectAgentId, () => finish('skipped'));
		// Declared after `finish`, which reads it: nothing calls `finish` before this line.
		const timer = setTimeout(() => finish('timeout'), timeoutMs);
		unsubscribe = useSessionStore.subscribe(check);
		check(useSessionStore.getState());
	});
}

async function runOffboarding(agentId: string): Promise<void> {
	const firing = firingHook(agentId, 'offboarding');
	if (!firing) return;
	const { subject, group, hook } = firing;

	const outcome = await queueLifecyclePrompt({ ...firing, stage: 'offboarding' });
	if (!outcome.ok) {
		notifyToast({
			type: 'warning',
			title: 'Offboarding Did Not Run',
			message: `${outcome.error} ${subject.name} was removed anyway.`,
		});
		return;
	}

	const timeoutMs = offboardingTimeoutMs(hook);
	const startedAt = Date.now();
	const lifecycle = useGroupLifecycleStore.getState();
	lifecycle.begin({
		subjectAgentId: subject.id,
		subjectName: subject.name,
		groupName: group.name,
		runAgentId: outcome.report.runAgentId,
		tabId: outcome.report.tabId,
		tabName: outcome.report.tabName,
		startedAt,
		deadline: startedAt + timeoutMs,
	});
	try {
		const result = await waitForQueuedTurn(
			outcome.report.runAgentId,
			outcome.report.tabId,
			outcome.itemId,
			timeoutMs,
			subject.id
		);
		if (result === 'timeout') {
			notifyToast({
				type: 'warning',
				title: 'Offboarding Ran Out of Time',
				message: `Offboarding for ${subject.name} did not finish in ${humanizeDuration(timeoutMs)}. The agent was removed anyway.`,
			});
		} else if (result === 'failed') {
			notifyToast({
				type: 'warning',
				title: 'Offboarding Did Not Run',
				message: `The Offboarding turn for ${subject.name} could not start. The agent was removed anyway.`,
			});
		}
	} finally {
		useGroupLifecycleStore.getState().end(subject.id);
	}
}

/**
 * Run the group's Offboarding for an agent about to be removed, and wait for it.
 * Call it before the removal kills anything. Resolves when the turn finished,
 * when the hook's time limit ran out, or when the person pressed "Remove now";
 * never rejects, so the removal always goes ahead.
 */
export function offboardBeforeRemoval(agentId: string): Promise<void> {
	const existing = inFlight.get(agentId);
	if (existing) return existing;
	const run = runOffboarding(agentId)
		.catch((error) => {
			captureException(error, { extra: { agentId, operation: 'group-offboarding' } });
		})
		.finally(() => inFlight.delete(agentId));
	inFlight.set(agentId, run);
	return run;
}

// ============================================================================
// Run now
// ============================================================================

/**
 * Run one stage's prompt now, on one agent of the group, whether the hook is on
 * or not. Queues the prompt and returns; an Offboarding run here removes
 * nothing.
 *
 * `draft` is the hook as Group Settings holds it, unsaved: "Run now" tries the
 * prompt as typed. The CLI passes none and runs the stored hook.
 */
export async function runGroupLifecycleNow(
	groupId: string,
	stage: GroupLifecycleStage,
	agentId: string,
	draft?: GroupLifecycleHook
): Promise<GroupLifecycleRunOutcome> {
	const { sessions, groups } = useSessionStore.getState();
	const group = groups.find((candidate) => candidate.id === groupId);
	if (!group) return { ok: false, error: 'Group not found' };
	if (isWorktreeGroup(group)) {
		return {
			ok: false,
			error: `"${group.name}" is a worktree group, which has no lifecycle prompts.`,
		};
	}
	const label = GROUP_LIFECYCLE_STAGE_LABELS[stage];
	const hook = draft ?? normalizeGroupLifecycle(group.lifecycle)?.[stage];
	if (!hook || !hook.prompt.trim()) {
		return { ok: false, error: `"${group.name}" has no ${label} prompt.` };
	}
	const subject = sessions.find((agent) => agent.id === agentId);
	if (!subject) return { ok: false, error: 'Agent not found' };
	if (lifecycleGroupFor(subject, groups)?.id !== group.id) {
		return { ok: false, error: `${subject.name} is not in "${group.name}".` };
	}
	try {
		return await queueLifecyclePrompt({ group, hook, stage, subject });
	} catch (error) {
		captureException(error, {
			extra: { groupId, agentId, stage, operation: 'run-group-lifecycle' },
		});
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
