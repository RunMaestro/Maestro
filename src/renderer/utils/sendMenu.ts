/**
 * The Send button's menu: what clicking Send offers while the agent is working.
 *
 * Four ways to send one draft, each the same code path its keyboard chord or
 * queue-card button already runs: Queue (plain send), Force Send (Forced
 * Parallel Send), Queue Held (queue it paused), and Steer (Steer Running Turn).
 * This module only decides which rows are live and what a dead row says, so the
 * popover stays a renderer and the rules stay testable.
 *
 * The menu opens only when there is a real choice to make: the agent is working
 * and there is a draft. An idle click just sends, because three of the four rows
 * mean nothing with no turn running.
 */

import { projectTabProvider, resolveTabProvider, resolveTurnProvider } from './providerTabSessions';
import type { Session } from '../types';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { getClaudeTokenMode } from '../../shared/claudeTokenMode';
import { resolveCodexTransport } from '../../shared/codexTransport';
import { describeSteerBlocked, getSteerEligibility } from './executionQueue';
import { isSessionRemote } from './sessionHelpers';

export type SendMenuAction = 'queue' | 'force' | 'hold' | 'steer';

/** Public docs section on steering, linked from the Steer row's help. */
export const STEER_DOCS_URL = 'https://docs.runmaestro.ai/general-usage#steer';

/** Where the Codex transport is documented. */
export const CODEX_TRANSPORT_DOCS_URL = 'https://docs.runmaestro.ai/provider-notes';

/**
 * Whether this agent's harness can be steered at all, separate from whether
 * THIS draft can be steered right now. The `?` beside Steer needs the split:
 * a capability gap has a fix (or a feature request), a momentary block (no turn
 * running, images attached) does not, and sending people to change a setting
 * that is already right is worse than no help.
 */
export type SteerSupport =
	| { kind: 'supported' }
	| { kind: 'fixable'; reason: 'api-token-source' | 'codex-exec'; detail: string }
	| { kind: 'unsupported'; reason: 'ssh-remote' | 'not-claude'; detail: string };

/**
 * Classify the harness. Same order of checks as {@link getSteerEligibility}, so
 * the help can never name a different cause than the row's reason line.
 */
export function getSteerSupport(
	session: Pick<
		Session,
		| 'toolType'
		| 'codexTransport'
		| 'claudeInteractive'
		| 'enableMaestroP'
		| 'maestroPMode'
		| 'sshRemoteId'
		| 'sessionSshRemoteConfig'
	>
): SteerSupport {
	const name = getAgentDisplayName(session.toolType);
	// Codex first: app-server steers over SSH too, so a remote Codex agent's gap is
	// its transport, which has a fix.
	if (session.toolType === 'codex') {
		if (resolveCodexTransport(session) === 'app-server') return { kind: 'supported' };
		return {
			kind: 'fixable',
			reason: 'codex-exec',
			detail:
				'This Codex agent runs on the exec transport, which takes no input while a turn runs. Set Codex Transport to app server in the agent settings to steer it.',
		};
	}
	if (isSessionRemote(session)) {
		return {
			kind: 'unsupported',
			reason: 'ssh-remote',
			detail: `This agent runs on an SSH remote. A turn on another host cannot be steered.`,
		};
	}
	if (session.toolType === 'claude-code') {
		const resolved = session.claudeInteractive?.mode;
		const configured = getClaudeTokenMode(session);
		if (resolved === 'interactive' || (!resolved && configured === 'interactive')) {
			return { kind: 'supported' };
		}
		return {
			kind: 'fixable',
			reason: 'api-token-source',
			detail:
				configured === 'api'
					? 'This Claude Code agent uses the API token source, which takes no input until a turn ends. Set the token source to TUI in the agent settings to steer it.'
					: 'Dynamic mode moved this agent to the API token source, which takes no input until a turn ends. Steering works again on the next TUI turn, or set the token source to TUI in the agent settings.',
		};
	}
	return {
		kind: 'unsupported',
		reason: 'not-claude',
		detail: `Steering is unavailable for ${name}. If its CLI takes input while a turn runs, open a feature request and we will wire it up.`,
	};
}

/** A GitHub issue pre-filled to ask for steering on a harness Maestro cannot steer yet. */
export function steerFeatureRequestUrl(toolType: Session['toolType']): string {
	const name = getAgentDisplayName(toolType);
	const title = `Steering support for ${name}`;
	const body = `Steer Running Turn is unavailable for ${name}.\n\nDoes the ${name} CLI accept input while a turn is running? If so, how (stdin, a socket, an RPC method)?\n`;
	return `https://github.com/RunMaestro/Maestro/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

/** Whether any tab of this agent is mid-turn. */
export function isAgentWorking(session: Pick<Session, 'state' | 'aiTabs'>): boolean {
	return session.state === 'busy' || (session.aiTabs ?? []).some((tab) => tab.state === 'busy');
}

/**
 * Whether a click on Send opens the menu rather than sending. Only in AI mode,
 * only with something to send, and only while the agent works: that is when the
 * four rows are different choices.
 */
export function shouldOpenSendMenu(
	session: Pick<Session, 'state' | 'aiTabs' | 'inputMode'> | null | undefined,
	opts: { menuEnabled: boolean; hasDraft: boolean }
): boolean {
	if (!session || !opts.menuEnabled || !opts.hasDraft) return false;
	if (session.inputMode !== 'ai') return false;
	return isAgentWorking(session);
}

export interface SendMenuRow {
	action: SendMenuAction;
	enabled: boolean;
	/** One line under a dead row saying why it is dead. */
	reason?: string;
	/**
	 * A dead row that still does something on click: it opens the setting that
	 * would make it live (Force Send while Forced Parallel Execution is off).
	 */
	opensSetting?: boolean;
}

export interface SendMenuModel {
	rows: SendMenuRow[];
	steerSupport: SteerSupport;
	steerProvider: Session['toolType'];
	/** The active tab is the one mid-turn (as opposed to another tab of the agent). */
	activeTabWorking: boolean;
}

/**
 * The four rows for the active tab's draft.
 *
 * Force Send needs the active tab IDLE (a tab runs one turn at a time) and the
 * Forced Parallel setting on; Steer needs the active tab BUSY. So at most one of
 * the two is ever live, the same pairing the queued card enforces.
 */
export function buildSendMenuModel(
	session: Session,
	draft: { text: string; imageCount: number },
	opts: { forcedParallelEnabled: boolean }
): SendMenuModel {
	const activeTab = session.aiTabs?.find((tab) => tab.id === session.activeTabId);
	const activeTabWorking = activeTab?.state === 'busy';
	const steerProvider = resolveTurnProvider(activeTab, session);
	const steerSupport: SteerSupport =
		activeTabWorking && steerProvider === 'codex' && activeTab?.turnCodexTransport === 'app-server'
			? { kind: 'supported' }
			: getSteerSupport(projectTabProvider(session, activeTab, steerProvider).agent);

	const force: SendMenuRow = activeTabWorking
		? {
				action: 'force',
				enabled: false,
				reason: 'This tab is working, and a tab runs one turn at a time.',
			}
		: !opts.forcedParallelEnabled
			? {
					action: 'force',
					enabled: false,
					reason: 'Forced Parallel Execution is off. Click to turn it on.',
					opensSetting: true,
				}
			: { action: 'force', enabled: true };

	let steer: SendMenuRow;
	if (steerSupport.kind !== 'supported') {
		steer = { action: 'steer', enabled: false, reason: describeSteerBlocked(steerSupport.reason) };
	} else {
		// The draft as the queued item it would become, judged by the same predicate
		// the steer itself runs, so the row cannot promise what the steer refuses.
		const eligibility = getSteerEligibility(session, {
			tabId: session.activeTabId,
			turnSettings: { provider: resolveTabProvider(activeTab, session) },
			text: draft.text,
			images: draft.imageCount > 0 ? new Array<string>(draft.imageCount).fill('') : undefined,
			readOnlyMode: activeTab?.readOnlyMode === true || undefined,
		});
		steer = eligibility.canSteer
			? { action: 'steer', enabled: true }
			: {
					action: 'steer',
					enabled: false,
					reason: describeSteerBlocked(eligibility.blockedReason),
				};
	}

	return {
		rows: [{ action: 'queue', enabled: true }, force, steer, { action: 'hold', enabled: true }],
		steerSupport,
		steerProvider,
		activeTabWorking,
	};
}
