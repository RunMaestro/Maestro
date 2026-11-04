import type { MentionRouting } from '../crossAgentContext';
/** Public, nonsecret dispatch journal and receipt. No caller proof or prompt is persisted. */
import type { CallerRunIdentity } from '../agentDelegation';
import { isPianolaScopeId } from './pianola-scope';

export type PianolaDispatchOutcome = 'not-started' | 'queued' | 'accepted' | 'unknown' | 'rejected';
export interface PianolaDispatchReceipt {
	version: 1;
	dispatchId: string;
	scopeId?: string;
	targetAgentId: string;
	targetTabId?: string;
	queueItemId?: string;
	runId?: string;
	supervision:
		| 'enrolled'
		| 'already-covered'
		| 'paused'
		| 'excluded'
		| 'unmanaged'
		| 'feature-off'
		| 'unavailable';
	outcome: PianolaDispatchOutcome;
}
export interface PianolaDispatchAdmission extends PianolaDispatchReceipt {
	scopeId: string;
	caller: CallerRunIdentity;
	/** Hash of immutable dispatch intent, including prompt and placement. */
	intentFingerprint: string;
	policyFingerprint: string;
	phase: 'prepared' | 'bound' | 'enrolled' | 'released' | 'settled';
}

/** Strict read boundary: a corrupt journal must never become a new dispatch. */
export function validatePianolaDispatchAdmission(raw: unknown): PianolaDispatchAdmission | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const r = raw as PianolaDispatchAdmission;
	const id = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.length <= 500;
	if (
		r.version !== 1 ||
		!isPianolaScopeId(r.dispatchId) ||
		!isPianolaScopeId(r.scopeId) ||
		!id(r.targetAgentId) ||
		!r.caller ||
		!id(r.caller.agentId) ||
		!id(r.caller.tabId) ||
		!id(r.caller.spawnGeneration) ||
		![r.intentFingerprint, r.policyFingerprint].every(
			(v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
		) ||
		!['prepared', 'bound', 'enrolled', 'released', 'settled'].includes(r.phase) ||
		!['enrolled', 'already-covered', 'paused', 'excluded', 'feature-off', 'unavailable'].includes(
			r.supervision
		) ||
		!['not-started', 'queued', 'accepted', 'unknown', 'rejected'].includes(r.outcome) ||
		[r.targetTabId, r.queueItemId, r.runId].some((v) => v !== undefined && !id(v)) ||
		(r.phase !== 'prepared' && !id(r.targetTabId)) ||
		(['prepared', 'bound', 'enrolled'].includes(r.phase) && r.outcome !== 'not-started') ||
		(r.phase === 'released' && r.outcome !== 'unknown') ||
		(r.phase === 'settled' && !['accepted', 'queued', 'unknown', 'rejected'].includes(r.outcome))
	)
		return null;
	return r;
}

/** Host-to-owning-renderer protocol; never accepted from a WebSocket payload. */
export interface PianolaNewTabControl {
	phase: 'prepare' | 'release';
	dispatchId: string;
	tabId: string;
}

export type NewAITabWithPromptResult = {
	unknown?: boolean;
	success: boolean;
	tabId?: string;
	queued?: boolean;
	error?: string;
};
export type NewAITabWithPromptCallback = (
	sessionId: string,
	prompt: string,
	background?: boolean,
	/** Create the tab with no chip in the strip (see `AITab.hidden`). */
	hidden?: boolean,
	/** `dispatch --routing`: the `@mention` routing the composer strip would set. */
	mentionRouting?: MentionRouting,
	control?: PianolaNewTabControl
) => Promise<NewAITabWithPromptResult>;
