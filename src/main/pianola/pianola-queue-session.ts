/** Native capture provenance for the one-time initialization of a queued tab.
 * Kept in the existing AgentRun ledger; neither a renderer ID nor a dispatch
 * receipt can manufacture this evidence. Missing/ambiguous history fails closed.
 */
import type { AgentRun } from '../../shared/agent-run';
import type { PianolaDispatchAdmission } from '../../shared/pianola/pianola-dispatch';

export interface NativeTabSession {
	agentId: string;
	tabId: string;
	createdAt: number;
	initialSessionId?: string | null;
	announcedSessionId?: string;
	conflicted?: true;
}

export function nativeTabSession(run: AgentRun): NativeTabSession | undefined {
	const value = run.metadata?.nativeTabSession as NativeTabSession | undefined;
	if (
		!value ||
		typeof value.agentId !== 'string' ||
		typeof value.tabId !== 'string' ||
		!Number.isSafeInteger(value.createdAt) ||
		(value.initialSessionId != null && typeof value.initialSessionId !== 'string') ||
		(value.announcedSessionId !== undefined &&
			(typeof value.announcedSessionId !== 'string' || !value.announcedSessionId)) ||
		(value.conflicted !== undefined && value.conflicted !== true) ||
		run.sessionId !== `${value.agentId}-ai-${value.tabId}` ||
		run.tabId !== value.tabId
	)
		return undefined;
	return value;
}

export function initialQueueSession(
	runs: AgentRun[],
	tab: {
		agentId: string;
		tabId: string;
		createdAt: number;
		agentSessionId?: string | null;
		busy: boolean;
	}
): { runId?: string } | undefined {
	if (tab.agentSessionId) return undefined;
	const history = runs.filter((run) => run.sessionId === `${tab.agentId}-ai-${tab.tabId}`);
	// A legacy capture with no creation identity cannot certify a fresh tab.
	if (history.some((run) => !nativeTabSession(run))) return undefined;
	const generation = history.filter((run) => nativeTabSession(run)!.createdAt === tab.createdAt);
	if (!generation.length && !tab.busy) return {};
	if (generation.length !== 1 || !tab.busy) return undefined;
	const run = generation[0];
	const identity = nativeTabSession(run)!;
	return run.status === 'running' && !identity.initialSessionId && !identity.conflicted
		? { runId: run.id }
		: undefined;
}

export function queueSessionMatches(
	record: PianolaDispatchAdmission,
	currentSessionId: string | null | undefined,
	runs: AgentRun[]
): boolean {
	const authority = record.queueAuthority!;
	if (authority.agentSessionId || !authority.initialSession)
		return currentSessionId === authority.agentSessionId;
	const history = runs.filter(
		(run) => run.sessionId === `${record.targetAgentId}-ai-${record.targetTabId}`
	);
	if (history.some((run) => !nativeTabSession(run))) return false;
	const initial = history.filter((run) => {
		const identity = nativeTabSession(run)!;
		return identity.createdAt === authority.createdAt && !identity.initialSessionId;
	});
	if (!initial.length)
		return !authority.initialSession.runId && currentSessionId === authority.agentSessionId;
	if (initial.length !== 1) return false;
	const run = initial[0];
	const identity = nativeTabSession(run)!;
	return (
		identity.agentId === record.targetAgentId &&
		identity.tabId === record.targetTabId &&
		!identity.conflicted &&
		run.status === 'completed' &&
		(authority.initialSession.runId
			? run.id === authority.initialSession.runId
			: run.createdAt >= authority.acceptedAt) &&
		!!identity.announcedSessionId &&
		currentSessionId === identity.announcedSessionId
	);
}
