import type { MentionRouting } from '../crossAgentContext';
import { isPianolaScopeCursor, type PianolaScopeCursor } from './pianola-scope-checkpoint';
/** Dispatch receipts and the host-only admission journal. Queue prepares retain the exact held row. */
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
export interface PianolaQueueCallbackProof {
	registration: {
		targetAgentId: string;
		targetTabId: string;
		callerAgentId: string;
		callerTabId?: string;
		callbackPrompt?: string;
		timeoutMs: number;
		prompt: string;
		pendingAdmissionId?: string;
	};
	expiresAt: number;
	owner: import('./pianola-scope').PianolaScopeOwner;
	callerTab?: { createdAt: number; agentSessionId?: string | null };
}
/** Pinned by the host at prepare, never supplied as send authority by a renderer. */
export interface PianolaQueueRouting {
	rendererConsumer?: true;
	completed?: true;
	routing: MentionRouting;
	targets: { agentId: string; fingerprint: string }[];
	steps: {
		kind: 'consult' | 'local' | 'handoff';
		stage?: 'reply';
		targetAgentId: string;
		requestId: string;
		status: 'prepared' | 'intent' | 'unknown' | 'started' | 'settled';
		runId?: string;
		processId?: string;
		startError?: string;
		pid?: number;
		agentSessionId?: string;
		terminal?: { text: string; error?: string; canceled?: boolean };
	}[];
}
export interface PianolaDispatchAdmission extends PianolaDispatchReceipt {
	scopeId: string;
	caller: CallerRunIdentity;
	/** Hash of immutable dispatch intent, including prompt and placement. */
	intentFingerprint: string;
	policyFingerprint: string;
	phase: 'prepared' | 'bound' | 'enrolled' | 'released' | 'settled';
	/** Minted only while the original caller proof is active. Exact target and
	 * policy pinned for at most 24 hours; older journals without it stay held. */
	queueAuthority?: {
		acceptedAt: number;
		expiresAt: number;
		bindingFingerprint: string;
		createdAt: number;
		agentSessionId?: string | null;
		/** Native capture frontier at authenticated prepare; absent on legacy journals. */
		initialSession?: { runId?: string };
	};
	queueRouting?: PianolaQueueRouting;
	queueCancelled?: true;
	queueRelease?: { generation: string; baseline: PianolaScopeCursor | null };
	queuePrepare?: {
		phase: 'unknown' | 'durable';
		item: PianolaQueueItem;
		callbackId?: string;
		callbackProof?: PianolaQueueCallbackProof;
	};
}

/** Strict read boundary: a corrupt journal must never become a new dispatch. */
export function validatePianolaDispatchAdmission(raw: unknown): PianolaDispatchAdmission | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const r = raw as PianolaDispatchAdmission;
	const id = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.length <= 500;
	if (
		r.version !== 1 ||
		(r.queueCancelled !== undefined && r.queueCancelled !== true) ||
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
		(['prepared', 'bound', 'enrolled'].includes(r.phase) &&
			r.outcome !== 'not-started' &&
			!r.queuePrepare) ||
		(r.phase === 'released' && r.outcome !== 'unknown') ||
		(r.phase === 'settled' && !['accepted', 'queued', 'unknown', 'rejected'].includes(r.outcome))
	)
		return null;
	if (
		r.queuePrepare &&
		(!['bound', 'enrolled', 'released', 'settled'].includes(r.phase) ||
			!['unknown', 'durable'].includes(r.queuePrepare.phase) ||
			(r.phase === 'bound' && !['unknown', 'queued'].includes(r.outcome)) ||
			r.queuePrepare.item?.id !== r.queueItemId ||
			r.queuePrepare.item?.tabId !== r.targetTabId ||
			r.queuePrepare.item?.pendingAdmissionId !== r.dispatchId ||
			r.queuePrepare.item?.type !== 'message' ||
			(r.phase === 'bound' && (r.queuePrepare.phase === 'durable') !== (r.outcome === 'queued')))
	)
		return null;
	if (r.queueRouting) {
		const routing = r.queueRouting;
		if (
			!r.queuePrepare ||
			!r.queuePrepare.item.crossAgentMention ||
			!['only', 'parallel', 'consult-first', 'handoff'].includes(routing.routing) ||
			(routing.rendererConsumer !== undefined && routing.rendererConsumer !== true) ||
			(routing.completed !== undefined && routing.completed !== true) ||
			!Array.isArray(routing.targets) ||
			!routing.targets.length ||
			routing.targets.some((t) => !t || !id(t.agentId) || !/^[a-f0-9]{64}$/.test(t.fingerprint)) ||
			new Set(routing.targets.map((t) => t.agentId)).size !== routing.targets.length ||
			!Array.isArray(routing.steps) ||
			!routing.steps.length ||
			new Set(routing.steps.map((s) => s.requestId)).size !== routing.steps.length ||
			routing.steps.some(
				(s) =>
					!s ||
					!isPianolaScopeId(s.requestId) ||
					!['consult', 'local', 'handoff'].includes(s.kind) ||
					(s.stage !== undefined &&
						(s.stage !== 'reply' || s.kind !== 'local' || routing.routing !== 'parallel')) ||
					!['prepared', 'intent', 'unknown', 'started', 'settled'].includes(s.status) ||
					(s.kind === 'local'
						? s.targetAgentId !== r.targetAgentId
						: !routing.targets.some((t) => t.agentId === s.targetAgentId)) ||
					(s.runId !== undefined && !id(s.runId)) ||
					(s.processId !== undefined && !id(s.processId)) ||
					(s.startError !== undefined && typeof s.startError !== 'string') ||
					(s.agentSessionId !== undefined && !id(s.agentSessionId)) ||
					(s.pid !== undefined && (!Number.isSafeInteger(s.pid) || s.pid <= 0)) ||
					(s.terminal !== undefined &&
						(!s.terminal ||
							typeof s.terminal.text !== 'string' ||
							(s.terminal.error !== undefined && typeof s.terminal.error !== 'string') ||
							(s.terminal.canceled !== undefined && typeof s.terminal.canceled !== 'boolean')))
			)
		)
			return null;
	}
	if (r.queuePrepare?.callbackProof) {
		const proof = r.queuePrepare.callbackProof;
		const registration = proof.registration;
		if (
			!registration ||
			!proof.owner ||
			!id(proof.owner.id) ||
			typeof proof.owner.cwd !== 'string' ||
			typeof proof.owner.isPianola !== 'boolean' ||
			typeof proof.owner.remote !== 'boolean' ||
			proof.owner.id !== registration.callerAgentId ||
			!id(registration.callerAgentId) ||
			(registration.callerTabId !== undefined && !id(registration.callerTabId)) ||
			(registration.callbackPrompt !== undefined &&
				typeof registration.callbackPrompt !== 'string') ||
			registration.targetAgentId !== r.targetAgentId ||
			registration.targetTabId !== r.targetTabId ||
			registration.pendingAdmissionId !== r.dispatchId ||
			registration.prompt !== (r.queuePrepare.item.text ?? '') ||
			!Number.isFinite(registration.timeoutMs) ||
			registration.timeoutMs < 1000 ||
			registration.timeoutMs > 86_400_000 ||
			!Number.isSafeInteger(proof.expiresAt) ||
			(registration.callerTabId &&
				(!proof.callerTab ||
					!Number.isSafeInteger(proof.callerTab.createdAt) ||
					(proof.callerTab.agentSessionId != null && !id(proof.callerTab.agentSessionId))))
		)
			return null;
	}

	if (
		r.queueAuthority &&
		(!r.queuePrepare ||
			!Number.isSafeInteger(r.queueAuthority.acceptedAt) ||
			!Number.isSafeInteger(r.queueAuthority.expiresAt) ||
			r.queueAuthority.expiresAt <= r.queueAuthority.acceptedAt ||
			r.queueAuthority.expiresAt - r.queueAuthority.acceptedAt > 86_400_000 ||
			!Number.isSafeInteger(r.queueAuthority.createdAt) ||
			!/^[a-f0-9]{64}$/.test(r.queueAuthority.bindingFingerprint) ||
			(r.queueAuthority.agentSessionId != null && !id(r.queueAuthority.agentSessionId)) ||
			(r.queueAuthority.initialSession !== undefined &&
				(!r.queueAuthority.initialSession ||
					typeof r.queueAuthority.initialSession !== 'object' ||
					Array.isArray(r.queueAuthority.initialSession) ||
					!!r.queueAuthority.agentSessionId ||
					(r.queueAuthority.initialSession.runId !== undefined &&
						!id(r.queueAuthority.initialSession.runId)))))
	)
		return null;
	if (
		r.queueRelease &&
		(!r.queueAuthority ||
			!isPianolaScopeId(r.queueRelease.generation) ||
			!isPianolaScopeCursor(r.queueRelease.baseline) ||
			!['released', 'settled'].includes(r.phase))
	)
		return null;

	return r;
}

/** Only main can issue a held, fully specified queue prepare. No release is implied. */
export interface PianolaQueueControl {
	dispatchId: string;
	item: PianolaQueueItem;
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

/** The exact host-issued message row. This wire subset contains no renderer dependencies. */
export interface PianolaQueueItem {
	id: string;
	timestamp: number;
	type: 'message';
	text: string;
	tabId: string;
	pendingAdmissionId: string;
	images?: string[];
	tabName?: string;
	readOnlyMode?: boolean;
	crossAgentMention?: boolean;
	crossAgentOnly?: boolean;
	mentionRouting?: MentionRouting;
	turnSettings?: { model?: string; effort?: string };
	paused?: boolean;
}
