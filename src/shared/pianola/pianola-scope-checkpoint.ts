/** Durable cursors for a single scope worker. An invalid checkpoint is never a
 * fresh enrollment: callers must suspend and surface the error instead. */
import { isValidClassification } from './storage';
import { isPianolaScopeId } from './pianola-scope';
import type { WatchState } from './pianola-watcher';

export interface PianolaScopeCursor {
	id: string;
	count: number;
	textLength: number;
}

/** Metadata coverage is an observation, never a delivery/acknowledgment receipt. */
export interface PianolaScopeTabCoverage {
	observedAt: number;
	status: 'covered' | 'blocked' | 'paused' | 'excluded' | 'closed';
	ownerScopeId: string | null;
	reason: string;
	nextActor: 'worker' | 'operator' | 'none';
	nextAction: string;
}

/** Current status projection; historical checkpoints remain available separately. */
export interface PianolaScopeCoverage {
	configurationFingerprint: string | null;
	checkpointFingerprint: string | null;
	censusAt: number | null;
	ageMs: number | null;
	staleAfterMs: number;
	fresh: boolean;
	status: 'covered' | 'blocked' | 'stale' | 'paused';
	reason: string;
	nextActor: 'worker' | 'operator' | 'none';
	nextAction: string;
	tabs: Array<{
		agentId: string;
		tabId: string;
		status: PianolaScopeTabCoverage['status'] | 'stale' | 'suspended';
		ownerScopeId: string | null;
		observedAt: number | null;
		reason: string;
		nextActor: PianolaScopeTabCoverage['nextActor'];
		nextAction: string;
		/** Original error remains visible even when scope freshness overrides status. */
		error?: string;
	}>;
}

export interface PianolaScopeCheckpointTab {
	agentId: string;
	tabId: string;
	/** Effective owner/root binding. Missing on an older checkpoint forces a baseline. */
	bindingFingerprint?: string;
	coverage?: PianolaScopeTabCoverage;
	baseline: PianolaScopeCursor | null;
	/** Only a live stream at enrollment may complete within the baseline entry. */
	baselineBusy?: boolean;
	lastSeen: PianolaScopeCursor | null;
	state: WatchState;
	status: 'active' | 'suspended' | 'closed';
	/** An intent persisted before delivery; an unknown outcome is never retried blindly. */
	unresolvedIntent: { decisionId: string; messageId: string; admitted?: boolean } | null;
}

export interface PianolaScopeCheckpoint {
	version: 1;
	scopeId: string;
	configurationFingerprint: string;
	activatedAt: number;
	/** Last complete metadata census; new membership alone is not new activity. */
	lastSnapshotAt?: number;
	/** Registry ownership inputs at census time, including overlapping/legacy watches. */
	coverageRegistryFingerprint?: string;
	lastCycleError?: { observedAt: number; reason: string };
	/** Round-robin position in the current native tab census. */
	nextTabIndex?: number;
	status: 'baselining' | 'armed' | 'suspended';
	tabs: PianolaScopeCheckpointTab[];
}

const FINGERPRINT = /^[0-9a-f]{64}$/i;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function id(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 500;
}

function nonnegativeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isPianolaScopeCursor(value: unknown): value is PianolaScopeCursor | null {
	return (
		value === null ||
		(record(value) &&
			id(value.id) &&
			nonnegativeInteger(value.count) &&
			value.count > 0 &&
			nonnegativeInteger(value.textLength))
	);
}

function state(value: unknown): boolean {
	if (!record(value) || !(value.lastHandledMessageId === null || id(value.lastHandledMessageId)))
		return false;
	if (
		value.pendingRetry !== null &&
		(!record(value.pendingRetry) ||
			!id(value.pendingRetry.messageId) ||
			!nonnegativeInteger(value.pendingRetry.attempts))
	)
		return false;
	if (
		value.pendingHandoff !== null &&
		(!record(value.pendingHandoff) ||
			!id(value.pendingHandoff.messageId) ||
			!nonnegativeInteger(value.pendingHandoff.polls) ||
			!isValidClassification(value.pendingHandoff.classification))
	)
		return false;
	return true;
}

/** Reject the entire checkpoint on corruption, duplicate membership or unknown schema. */
export function validatePianolaScopeCheckpoint(
	raw: unknown,
	expectedId: string
): PianolaScopeCheckpoint | null {
	if (
		!isPianolaScopeId(expectedId) ||
		!record(raw) ||
		raw.version !== 1 ||
		raw.scopeId !== expectedId ||
		typeof raw.configurationFingerprint !== 'string' ||
		!FINGERPRINT.test(raw.configurationFingerprint) ||
		!nonnegativeInteger(raw.activatedAt) ||
		(raw.lastSnapshotAt !== undefined &&
			(!nonnegativeInteger(raw.lastSnapshotAt) || raw.lastSnapshotAt < raw.activatedAt)) ||
		(raw.status !== 'baselining' && raw.status !== 'armed' && raw.status !== 'suspended') ||
		(raw.coverageRegistryFingerprint !== undefined &&
			(typeof raw.coverageRegistryFingerprint !== 'string' ||
				!FINGERPRINT.test(raw.coverageRegistryFingerprint))) ||
		(raw.nextTabIndex !== undefined && !nonnegativeInteger(raw.nextTabIndex)) ||
		!Array.isArray(raw.tabs) ||
		raw.tabs.length > 10000
	)
		return null;
	if (
		raw.lastCycleError !== undefined &&
		(!record(raw.lastCycleError) ||
			!nonnegativeInteger(raw.lastCycleError.observedAt) ||
			typeof raw.lastCycleError.reason !== 'string' ||
			raw.lastCycleError.reason.length > 4000)
	)
		return null;
	const members = new Set<string>();
	for (const tab of raw.tabs) {
		if (
			!record(tab) ||
			!id(tab.agentId) ||
			!id(tab.tabId) ||
			(tab.bindingFingerprint !== undefined &&
				(typeof tab.bindingFingerprint !== 'string' ||
					!FINGERPRINT.test(tab.bindingFingerprint))) ||
			!isPianolaScopeCursor(tab.baseline) ||
			(tab.baselineBusy !== undefined && typeof tab.baselineBusy !== 'boolean') ||
			!isPianolaScopeCursor(tab.lastSeen) ||
			!state(tab.state) ||
			(tab.status !== 'active' && tab.status !== 'suspended' && tab.status !== 'closed')
		)
			return null;
		if (
			tab.unresolvedIntent !== null &&
			(!record(tab.unresolvedIntent) ||
				!id(tab.unresolvedIntent.decisionId) ||
				!id(tab.unresolvedIntent.messageId) ||
				(tab.unresolvedIntent.admitted !== undefined &&
					typeof tab.unresolvedIntent.admitted !== 'boolean'))
		)
			return null;
		if (tab.coverage !== undefined) {
			const coverage = tab.coverage;
			if (
				!record(coverage) ||
				!nonnegativeInteger(coverage.observedAt) ||
				!['covered', 'blocked', 'paused', 'excluded', 'closed'].includes(
					coverage.status as string
				) ||
				!(
					coverage.ownerScopeId === null ||
					(typeof coverage.ownerScopeId === 'string' && isPianolaScopeId(coverage.ownerScopeId))
				) ||
				typeof coverage.reason !== 'string' ||
				coverage.reason.length > 4000 ||
				!['worker', 'operator', 'none'].includes(coverage.nextActor as string) ||
				typeof coverage.nextAction !== 'string' ||
				coverage.nextAction.length > 4000
			)
				return null;
		}
		const key = JSON.stringify([tab.agentId, tab.tabId]);
		if (members.has(key)) return null;
		members.add(key);
	}
	return raw as unknown as PianolaScopeCheckpoint;
}
