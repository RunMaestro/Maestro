/**
 * One durable scope cycle, NODE ONLY. Its scope worker must call this serially;
 * discovery uses metadata and only changed working tabs need history.
 * Transports must enforce the supplied guard at final admission. There is no
 * unguarded fallback, including for a delayed manager reply.
 */
import { createHash } from 'crypto';
import { canonicalJson } from '../canonicalJson';
import type { DesktopSessionsSnapshot } from '../desktopTabs';
import type { PianolaFsStore } from './fs-store';
import {
	resolvePianolaScopeOwnership,
	type PianolaScopeCandidate,
	type PianolaScopeOwner,
	type PianolaScopeTab,
} from './pianola-scope';
import {
	validatePianolaScopeCheckpoint,
	isPianolaScopeCursor,
	type PianolaScopeCheckpoint,
	type PianolaScopeCheckpointTab,
	type PianolaScopeCursor,
} from './pianola-scope-checkpoint';
import {
	initialWatchState,
	rehydrateWatchState,
	runWatchIteration,
	type IterationResult,
	type PianolaJudgmentRequest,
	type WatchDeps,
	type WatchTarget,
} from './pianola-watcher';
import type { PianolaDecisionRecord, PianolaSupervisedTarget } from './storage';
import { decide } from './pianola-policy';
import type { PianolaMessage } from './types';
import {
	startPianolaDecision,
	updatePianolaDecision,
	reconcilePianolaDecision,
	pausePianolaScopeDecisions,
} from './pianola-decision-lifecycle';

export interface PianolaScopeSnapshotTab extends PianolaScopeTab {
	/** Host creation time, never the provider session's creation time. */
	createdAt: number;
	busy: boolean;
	cursorAvailable: boolean;
	cursor: PianolaScopeCursor | null;
}

export interface PianolaScopeSnapshot {
	/** Host time captured with the complete owner/tab snapshot. */
	capturedAt: number;
	complete: boolean;
	owners: PianolaScopeOwner[];
	tabs: PianolaScopeSnapshotTab[];
}

export interface PianolaScopeDeliveryGuard {
	scopeId: string;
	configurationFingerprint: string;
	bindingFingerprint: string;
	agentId: string;
	tabId: string;
	messageId: string;
	decisionId: string;
	cursor: PianolaScopeCursor;
}

/** Only a definitive admission rejection permits the watcher's bounded retry. */
export type PianolaScopeDeliveryResult =
	| { status: 'accepted' }
	| { status: 'rejected'; error: string }
	| { status: 'unknown'; error: string };

export interface PianolaScopeCycleDeps {
	store: Pick<
		PianolaFsStore,
		'readSupervisorTargets' | 'readScopeCheckpoint' | 'writeScopeCheckpoint' | 'readDecisions'
	>;
	/** Unavailable/incomplete metadata must throw or return complete:false. */
	readSnapshot: () => Promise<PianolaScopeSnapshot>;
	/** All log entries in native order, with stable IDs. A bounded fetch may refuse. */
	readTranscript: (target: WatchTarget) => Promise<{
		agentId: string;
		tabId: string;
		messages: PianolaMessage[];
	}>;
	watch: Omit<WatchDeps, 'dispatch' | 'requestJudgment'>;
	dispatch: (
		target: WatchTarget,
		answer: string,
		guard: PianolaScopeDeliveryGuard
	) => Promise<PianolaScopeDeliveryResult>;
	requestJudgment?: (
		request: PianolaJudgmentRequest,
		guard: PianolaScopeDeliveryGuard
	) => Promise<PianolaScopeDeliveryResult>;
}

export interface PianolaScopeCycleResult {
	status: PianolaScopeCheckpoint['status'];
	iterations: Array<{ agentId: string; tabId: string; result: IterationResult }>;
	/** Metadata, history or delivery uncertainty, suitable for scope health. */
	issues: string[];
}

function fingerprint(value: unknown): string {
	return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Labels and polling cadence do not change consent; unordered selections are sets. */
export function pianolaScopeConfigurationFingerprint(scope: PianolaScopeCandidate): string {
	const { selection } = scope;
	return fingerprint({
		managerAgentId: scope.managerAgentId,
		mode: selection.mode,
		...(selection.mode === 'agents-and-groups'
			? { agentIds: [...selection.agentIds].sort(), groupIds: [...selection.groupIds].sort() }
			: {
					projectRoots: [...selection.projectRoots].sort(),
					ownerRoots: selection.ownerRoots,
					includeWorktrees: selection.includeWorktrees,
				}),
		excludedAgentIds: [...selection.excludedAgentIds].sort(),
	});
}

/** All registry entries that can change ownership; labels/cadence are immaterial. */
export function pianolaCoverageRegistryFingerprint(targets: PianolaSupervisedTarget[]): string {
	return fingerprint(
		targets
			.filter((target) => target.kind === 'watch-scope' || target.kind === 'watch')
			.map((target) =>
				target.kind === 'watch-scope'
					? {
							id: target.id,
							enabled: target.enabled,
							createdAt: target.createdAt,
							configuration:
								target.selection && target.managerAgentId
									? pianolaScopeConfigurationFingerprint({
											...target,
											selection: target.selection,
											managerAgentId: target.managerAgentId,
										})
									: null,
						}
					: { id: target.id, enabled: target.enabled, agentId: target.agentId, tabId: target.tabId }
			)
			.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
	);
}

function scopesFrom(targets: PianolaSupervisedTarget[]): PianolaScopeCandidate[] {
	if (new Set(targets.map((target) => target.id)).size !== targets.length)
		throw new Error('Ambiguous Pianola registry IDs');
	return targets
		.filter((target) => target.kind === 'watch-scope')
		.map((target) => {
			if (!target.selection || !target.managerAgentId)
				throw new Error('Incomplete Pianola scope configuration');
			return { ...target, selection: target.selection, managerAgentId: target.managerAgentId };
		});
}

function assertSnapshot(snapshot: PianolaScopeSnapshot): void {
	if (
		snapshot.complete !== true ||
		!Number.isSafeInteger(snapshot.capturedAt) ||
		snapshot.capturedAt < 0 ||
		snapshot.tabs.length > 10000 ||
		new Set(snapshot.owners.map((owner) => owner.id)).size !== snapshot.owners.length ||
		snapshot.tabs.some(
			(tab) =>
				typeof tab.paused !== 'boolean' ||
				typeof tab.consult !== 'boolean' ||
				typeof tab.ephemeral !== 'boolean' ||
				typeof tab.busy !== 'boolean' ||
				typeof tab.cursorAvailable !== 'boolean' ||
				!isPianolaScopeCursor(tab.cursor)
		) ||
		new Set(snapshot.tabs.map((tab) => canonicalJson([tab.agentId, tab.tabId]))).size !==
			snapshot.tabs.length
	)
		throw new PianolaCensusError('Incomplete or ambiguous Pianola scope snapshot');
}

/** A census could not be obtained or was incomplete; the worker may retry it. */
export class PianolaCensusError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PianolaCensusError';
	}
}

/** Adapt the native tab-list response without accepting a legacy/partial census. */
export function pianolaScopeSnapshotFromDesktop(raw: unknown): PianolaScopeSnapshot {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw))
		throw new PianolaCensusError('Missing native supervision snapshot');
	const response = raw as Partial<DesktopSessionsSnapshot> & { success?: boolean };
	if (
		response.success !== true ||
		response.supervisionVersion !== 1 ||
		response.complete !== true ||
		!Array.isArray(response.owners) ||
		!Array.isArray(response.sessions) ||
		response.owners.length > 10000 ||
		response.sessions.length > 10000 ||
		response.owners.some(
			(owner) =>
				!owner ||
				typeof owner.id !== 'string' ||
				!owner.id ||
				typeof owner.cwd !== 'string' ||
				!owner.cwd ||
				!(owner.parentSessionId === null || typeof owner.parentSessionId === 'string') ||
				typeof owner.isPianola !== 'boolean' ||
				typeof owner.remote !== 'boolean'
		)
	)
		throw new PianolaCensusError('Incomplete native supervision census');
	const owners = response.owners;
	if (new Set(response.sessions.map((tab) => tab?.tabId)).size !== response.sessions.length)
		throw new PianolaCensusError('Ambiguous native supervision tab IDs');
	const tabs = response.sessions.map((tab) => {
		const info = tab?.supervision;
		const owner = owners.find((candidate) => candidate.id === tab?.agentId);
		if (
			!tab ||
			typeof tab.tabId !== 'string' ||
			!tab.tabId ||
			!Number.isSafeInteger(tab.createdAt) ||
			tab.createdAt < 0 ||
			!info ||
			typeof info.lineageComplete !== 'boolean' ||
			!owner ||
			info.cwd !== owner.cwd ||
			info.parentSessionId !== owner.parentSessionId ||
			info.groupId !== owner.groupId ||
			info.isPianola !== owner.isPianola ||
			info.remote !== owner.remote ||
			typeof info.paused !== 'boolean' ||
			typeof info.busy !== 'boolean'
		)
			throw new PianolaCensusError('Incomplete native supervision tab metadata');
		return {
			agentId: tab.agentId,
			tabId: tab.tabId,
			createdAt: tab.createdAt,
			paused: info.paused,
			busy: info.busy,
			consult: info.consult,
			ephemeral: info.ephemeral,
			cursorAvailable: info.cursorAvailable,
			cursor: info.cursor,
		};
	});
	const snapshot = {
		capturedAt: response.capturedAt!,
		complete: true,
		owners,
		tabs,
	};
	assertSnapshot(snapshot);
	return snapshot;
}

/**
 * Hash the identity binding. Directory and group moves that remain selected
 * preserve cursors; changing an owner's parent lineage requires a baseline.
 * Only called after the ownership resolver has verified the entire chain.
 */
function bindingFingerprint(
	scope: PianolaScopeCandidate,
	agentId: string,
	owners: PianolaScopeOwner[]
): string {
	const chain: Array<Omit<PianolaScopeOwner, 'cwd' | 'groupId'>> = [];
	let owner = owners.find((candidate) => candidate.id === agentId)!;
	for (;;) {
		chain.push({
			id: owner.id,
			parentSessionId: owner.parentSessionId ?? null,
			isPianola: owner.isPianola,
			remote: owner.remote,
		});
		if (!owner.parentSessionId) break;
		owner = owners.find((candidate) => candidate.id === owner.parentSessionId)!;
	}
	return fingerprint({
		managerAgentId: scope.managerAgentId,
		mode: scope.selection.mode,
		chain,
	});
}

function sameCursor(a: PianolaScopeCursor | null, b: PianolaScopeCursor | null): boolean {
	return (
		a === b || (!!a && !!b && a.id === b.id && a.count === b.count && a.textLength === b.textLength)
	);
}

function atCursor(messages: PianolaMessage[], cursor: PianolaScopeCursor | null): boolean {
	if (!cursor) return true;
	const message = messages[cursor.count - 1];
	return message?.id === cursor.id && message.content.length >= cursor.textLength;
}

function deliveryOutcome(result: PianolaScopeDeliveryResult): { success: boolean; error?: string } {
	if (result.status === 'accepted') return { success: true };
	if (result.status === 'rejected' && typeof result.error === 'string')
		return { success: false, error: result.error };
	throw new Error('Delivery outcome unknown; automatic retry suspended');
}

/**
 * Restores the checkpoint on every invocation. Persistence failures propagate;
 * the next cycle must read durable state, never continue with an uncommitted
 * in-memory cursor. A thrown/uncertain send retains its intent and is not retried.
 */
export async function runPianolaScopeCycle(
	scopeId: string,
	deps: PianolaScopeCycleDeps,
	options: { dryRun: boolean; maxTabs?: number; shouldStop?: () => boolean }
): Promise<PianolaScopeCycleResult> {
	const targets = deps.store.readSupervisorTargets();
	const scopes = scopesFrom(targets);
	const scope = scopes.find((candidate) => candidate.id === scopeId);
	let checkpoint = deps.store.readScopeCheckpoint(scopeId);
	const result: PianolaScopeCycleResult = { status: 'suspended', iterations: [], issues: [] };
	let persistenceFailed = false;
	let lastPersistedStatus = checkpoint?.status;
	let externallySuspended = false;
	const persist = (): void => {
		try {
			// The host may suspend the scope while this child awaits I/O. Never
			// overwrite that pause with an older in-memory armed checkpoint.
			const current = deps.store.readScopeCheckpoint(scopeId);
			if (current?.status === 'suspended' && lastPersistedStatus !== 'suspended')
				externallySuspended = true;
			if (
				externallySuspended ||
				!deps.store
					.readSupervisorTargets()
					.some((target) => target.id === scopeId && target.enabled)
			)
				checkpoint!.status = 'suspended';
			for (const saved of checkpoint!.tabs) {
				const durable = current?.tabs.find(
					(tab) => tab.agentId === saved.agentId && tab.tabId === saved.tabId
				);
				if (
					saved.unresolvedIntent &&
					durable?.unresolvedIntent?.decisionId === saved.unresolvedIntent.decisionId &&
					durable.unresolvedIntent.admitted
				)
					saved.unresolvedIntent.admitted = true;
			}
			deps.store.writeScopeCheckpoint(checkpoint!);
			lastPersistedStatus = checkpoint!.status;
		} catch (error) {
			persistenceFailed = true;
			throw error;
		}
	};
	if (!scope?.enabled) {
		pausePianolaScopeDecisions(
			scopeId,
			{ readDecisions: deps.store.readDecisions, appendDecision: deps.watch.recordDecision },
			deps.watch.now()
		);
		if (checkpoint) {
			checkpoint.status = 'suspended';
			persist();
		}
		return result;
	}
	if (scope.selection.mode !== 'agents-and-groups') {
		// Do not infer consent from old directory roots or replay its checkpoint
		// under a broader whole-agent selection. Explicit reconfiguration follows.
		if (checkpoint) {
			checkpoint.status = 'suspended';
			persist();
		}
		result.issues.push('Legacy scope requires explicit agent/group selection');
		return result;
	}
	const configurationFingerprint = pianolaScopeConfigurationFingerprint(scope);
	let snapshot: PianolaScopeSnapshot;
	try {
		snapshot = await deps.readSnapshot();
		assertSnapshot(snapshot);
		if (checkpoint && snapshot.capturedAt < (checkpoint.lastSnapshotAt ?? checkpoint.activatedAt))
			throw new Error('Pianola host clock precedes activation; scope remains inert');
	} catch (error) {
		// Keep the last successful census as historical evidence, while exposing
		// the most recent failure immediately (even within its freshness window).
		const observedAt = Date.parse(deps.watch.now());
		if (!checkpoint)
			checkpoint = {
				version: 1,
				scopeId,
				configurationFingerprint,
				activatedAt: observedAt,
				status: 'suspended',
				tabs: [],
			};
		checkpoint.lastCycleError = {
			observedAt,
			reason: (error instanceof Error ? error.message : 'Native census unavailable').slice(0, 4000),
		};
		persist();
		throw error;
	}
	const firstActivation = !checkpoint;
	const resume = checkpoint?.status !== 'armed';
	if (!checkpoint) {
		checkpoint = {
			version: 1,
			scopeId,
			configurationFingerprint,
			activatedAt: snapshot.capturedAt,
			status: 'baselining',
			tabs: [],
		};
		persist();
	} else if (!validatePianolaScopeCheckpoint(checkpoint, scopeId)) {
		throw new Error('Invalid Pianola scope checkpoint');
	}
	const configurationChanged = checkpoint.configurationFingerprint !== configurationFingerprint;
	const decisions = deps.store.readDecisions();
	for (const record of decisions) {
		if (record.lifecycle?.guard.scopeId !== scopeId || record.lifecycle.status === 'done') continue;
		const tab = snapshot.tabs.find(
			(candidate) => candidate.agentId === record.agentId && candidate.tabId === record.tabId
		);
		const ownership = tab
			? resolvePianolaScopeOwnership(
					tab,
					snapshot.owners,
					scopes,
					targets.filter((target) => target.kind === 'watch')
				)
			: null;
		if (!tab || tab.paused || ownership?.kind !== 'scope' || ownership.scopeId !== scopeId) {
			const status = !tab ? 'blocked' : 'paused';
			if (record.lifecycle.status !== status)
				deps.watch.recordDecision(
					updatePianolaDecision(
						record,
						{
							status,
							nextActor: !tab ? 'operator' : 'none',
							nextAction: !tab
								? 'Restore the original requesting agent/tab; never redirect its answer'
								: 'Resume the selected agent/scope, then revalidate the original ask',
						},
						deps.watch.now()
					)
				);
		}
	}
	const savedByKey = new Map(
		checkpoint.tabs.map((tab) => [canonicalJson([tab.agentId, tab.tabId]), tab])
	);
	const liveKeys = new Set(snapshot.tabs.map((tab) => canonicalJson([tab.agentId, tab.tabId])));
	for (const saved of checkpoint.tabs) {
		if (!liveKeys.has(canonicalJson([saved.agentId, saved.tabId]))) {
			saved.status = 'closed';
			saved.coverage = {
				observedAt: snapshot.capturedAt,
				status: 'closed',
				ownerScopeId: null,
				reason: 'Tab absent from the complete native census',
				nextActor: 'none',
				nextAction: 'Re-enroll with a fresh baseline if the tab returns',
			};
		}
	}
	const working: Array<{ tab: PianolaScopeSnapshotTab; saved: PianolaScopeCheckpointTab }> = [];
	for (const tab of snapshot.tabs) {
		const key = canonicalJson([tab.agentId, tab.tabId]);
		let saved = savedByKey.get(key);
		// Paused members are included in the enrollment baseline, never in work.
		const ownership = resolvePianolaScopeOwnership(
			{ ...tab, paused: false },
			snapshot.owners,
			scopes,
			targets.filter((target) => target.kind === 'watch')
		);
		if (ownership.kind !== 'scope' || ownership.scopeId !== scopeId) {
			if (saved) {
				saved.status = 'suspended';
				saved.coverage = {
					observedAt: snapshot.capturedAt,
					status: 'excluded',
					ownerScopeId: ownership.kind === 'scope' ? ownership.scopeId : null,
					reason: ownership.kind === 'excluded' ? ownership.reason : `Owned by ${ownership.kind}`,
					nextActor: 'none',
					nextAction: 'Coverage belongs to the current selection/owner',
				};
			}
			continue;
		}
		if (!tab.cursorAvailable) {
			// Persist even first-enrollment failures: otherwise a missing cursor
			// disappears from the status API entirely.
			if (!saved) {
				saved = {
					agentId: tab.agentId,
					tabId: tab.tabId,
					baseline: null,
					lastSeen: null,
					state: initialWatchState(),
					status: 'suspended',
					unresolvedIntent: null,
				};
				checkpoint.tabs.push(saved);
				savedByKey.set(key, saved);
			}
			saved.status = 'suspended';
			saved.coverage = {
				observedAt: snapshot.capturedAt,
				status: tab.paused ? 'paused' : 'blocked',
				ownerScopeId: scopeId,
				reason: 'Transcript cursor unavailable',
				nextActor: tab.paused ? 'none' : 'operator',
				nextAction: tab.paused
					? 'Resume the tab to enroll it'
					: 'Restore native transcript cursor access; next census baselines this tab',
			};
			result.issues.push(`Transcript cursor unavailable: ${tab.agentId}/${tab.tabId}`);
			continue;
		}
		const binding = bindingFingerprint(scope, tab.agentId, snapshot.owners);
		const needsBaseline =
			firstActivation ||
			resume ||
			saved?.status !== 'active' ||
			saved.bindingFingerprint !== binding;
		if (!saved) {
			// Only a genuinely new host-created tab may expose its first ask. An
			// old/unknown timestamp, re-enrollment or ownership change baselines it.
			const createdAfterActivation =
				!firstActivation &&
				!resume &&
				!configurationChanged &&
				checkpoint.lastSnapshotAt !== undefined &&
				tab.createdAt > checkpoint.lastSnapshotAt &&
				tab.createdAt <= snapshot.capturedAt;
			saved = {
				agentId: tab.agentId,
				tabId: tab.tabId,
				bindingFingerprint: binding,
				baseline: createdAfterActivation && !tab.paused ? null : tab.cursor,
				baselineBusy: tab.busy && !tab.paused,
				lastSeen: createdAfterActivation && !tab.paused ? null : tab.cursor,
				state:
					createdAfterActivation && !tab.paused
						? rehydrateWatchState(
								decisions.filter((decision) => decision.agentId === tab.agentId),
								tab.tabId
							)
						: initialWatchState(),
				status: tab.paused ? 'suspended' : 'active',
				unresolvedIntent: null,
			};
			checkpoint.tabs.push(saved);
			savedByKey.set(key, saved);
		} else if (needsBaseline || tab.paused) {
			saved.baseline = tab.cursor;
			saved.baselineBusy = tab.busy && !tab.paused;
			saved.lastSeen = tab.cursor;
			saved.bindingFingerprint = binding;
			saved.state = initialWatchState();
			saved.status = tab.paused ? 'suspended' : 'active';
			// An unresolved intent survives loss of ownership, disable and close.
		}
		// A transcript failure persists until an actual successful retry. An
		// unchanged cursor alone must never clear the previous failure.
		if (tab.paused || saved.coverage?.status !== 'blocked' || needsBaseline) {
			saved.coverage = {
				observedAt: snapshot.capturedAt,
				status: tab.paused ? 'paused' : 'covered',
				ownerScopeId: scopeId,
				reason: tab.paused ? 'Tab paused' : 'Enrolled in current native census',
				nextActor: tab.paused ? 'none' : 'worker',
				nextAction: tab.paused
					? 'Resume the tab to continue monitoring'
					: 'Continue bounded transcript monitoring',
			};
		}
		const openDecision = decisions.some(
			(record) =>
				record.agentId === tab.agentId &&
				record.tabId === tab.tabId &&
				record.lifecycle?.guard.scopeId === scopeId &&
				record.lifecycle.status !== 'done'
		);
		if (
			!tab.paused &&
			(!tab.busy || openDecision) &&
			(saved.coverage?.status === 'blocked' ||
				!sameCursor(saved.lastSeen, tab.cursor) ||
				saved.baselineBusy ||
				saved.state.pendingRetry ||
				saved.state.pendingHandoff ||
				openDecision)
		)
			working.push({ tab, saved });
	}
	if (checkpoint.tabs.length > 10000) throw new Error('Pianola scope checkpoint membership limit');
	checkpoint.configurationFingerprint = configurationFingerprint;
	checkpoint.lastSnapshotAt = snapshot.capturedAt;
	checkpoint.coverageRegistryFingerprint = pianolaCoverageRegistryFingerprint(targets);
	checkpoint.status = 'armed';
	delete checkpoint.lastCycleError;
	// Commit the entire membership/baseline before any rule, handoff or notice.
	persist();
	result.status = checkpoint.status;
	if (checkpoint.status !== 'armed') return result;
	// Rotate over the census, not just changed tabs, so a failing/active prefix
	// cannot starve later agents. One scope child does serial, bounded work.
	const start = (checkpoint.nextTabIndex ?? 0) % Math.max(1, snapshot.tabs.length);
	const maxTabs = Math.max(1, Math.min(100, Math.floor(options.maxTabs ?? 20)));
	const positions = new Map(snapshot.tabs.map((tab, index) => [tab, index]));
	working.sort(
		(a, b) =>
			((positions.get(a.tab)! - start + snapshot.tabs.length) % snapshot.tabs.length) -
			((positions.get(b.tab)! - start + snapshot.tabs.length) % snapshot.tabs.length)
	);
	for (const { tab, saved } of working.slice(0, maxTabs)) {
		if (options.shouldStop?.() || externallySuspended) break;
		checkpoint.nextTabIndex = (positions.get(tab)! + 1) % snapshot.tabs.length;
		persist();
		try {
			const target: WatchTarget = {
				agentId: tab.agentId,
				tabId: tab.tabId,
				projectPath: snapshot.owners.find((owner) => owner.id === tab.agentId)!.cwd,
				groupId: snapshot.owners.find((owner) => owner.id === tab.agentId)!.groupId,
			};
			const history = await deps.readTranscript(target);
			const messages = history.messages;
			if (
				history.agentId !== tab.agentId ||
				history.tabId !== tab.tabId ||
				messages.length !== (tab.cursor?.count ?? 0) ||
				new Set(messages.map((message) => message.id)).size !== messages.length ||
				messages.some((message) => !message.id) ||
				!atCursor(messages, tab.cursor) ||
				!atCursor(messages, saved.baseline) ||
				!atCursor(messages, saved.lastSeen) ||
				(tab.cursor && messages[messages.length - 1]?.content.length !== tab.cursor.textLength)
			)
				throw new Error('Transcript cursor gap or changed snapshot');
			// Classify the full transcript so earlier assistant intent in the current
			// turn still raises risk. Eligibility is separate: unchanged history must
			// never become actionable just because a tool/system entry was appended.
			const offset = saved.baseline?.count ?? 0;
			const actionableIds = new Set(messages.slice(offset).map((message) => message.id));
			if (saved.baselineBusy && saved.baseline) {
				const streamed = messages[offset - 1];
				if (streamed?.id === saved.baseline.id && streamed.role === 'assistant')
					actionableIds.add(streamed.id);
			}
			// Settle earlier decisions before classifying another ask. Authorship is
			// established only by the controlled resolution path, never guessed.
			const currentRecords = deps.store.readDecisions();
			let pending = false;
			for (const record of currentRecords) {
				if (
					record.agentId !== tab.agentId ||
					record.tabId !== tab.tabId ||
					record.lifecycle?.guard.scopeId !== scopeId ||
					record.lifecycle.status === 'done'
				)
					continue;
				let observed = reconcilePianolaDecision(record, tab, messages, deps.watch.now());
				const life = observed.lifecycle!;
				// A selection edit can leave the same ask and owner in place. Rebind
				// only an unsent answer (or an already delivered judgment), never an
				// answer whose delivery may have reached the recipient.
				if (
					life.guard.configurationFingerprint !== configurationFingerprint &&
					life.guard.bindingFingerprint === saved.bindingFingerprint &&
					life.managerAgentId === scope.managerAgentId &&
					!life.acknowledgedAt &&
					!saved.unresolvedIntent &&
					!tab.busy &&
					sameCursor(life.guard.cursor, tab.cursor) &&
					actionableIds.has(life.guard.messageId) &&
					messages.some(
						(message) => message.id === life.guard.messageId && message.role === 'assistant'
					) &&
					((life.phase === 'none' && life.delivery === 'not_sent') ||
						(life.phase === 'judgment' && life.delivery === 'accepted') ||
						(life.phase === 'answer' && life.delivery === 'rejected'))
				) {
					const currentTargets = deps.store.readSupervisorTargets();
					const currentScopes = scopesFrom(currentTargets);
					const currentScope = currentScopes.find((candidate) => candidate.id === scopeId);
					const current = await deps.readSnapshot();
					assertSnapshot(current);
					const currentTab = current.tabs.find(
						(candidate) => candidate.agentId === tab.agentId && candidate.tabId === tab.tabId
					);
					const owner =
						currentTab &&
						resolvePianolaScopeOwnership(
							currentTab,
							current.owners,
							currentScopes,
							currentTargets.filter((candidate) => candidate.kind === 'watch')
						);
					// A native resolver may have claimed or settled the decision while
					// the fresh census was in flight. Never overwrite that writer.
					if (
						canonicalJson(
							deps.store.readDecisions().find((candidate) => candidate.id === record.id)
						) !== canonicalJson(record)
					) {
						pending = true;
						continue;
					}
					if (
						currentScope?.enabled &&
						current.capturedAt >= snapshot.capturedAt &&
						pianolaScopeConfigurationFingerprint(currentScope) === configurationFingerprint &&
						currentTab &&
						!currentTab.busy &&
						!currentTab.paused &&
						currentTab.cursorAvailable &&
						sameCursor(currentTab.cursor, tab.cursor) &&
						owner?.kind === 'scope' &&
						owner.scopeId === scopeId &&
						bindingFingerprint(currentScope, tab.agentId, current.owners) ===
							saved.bindingFingerprint &&
						!options.shouldStop?.() &&
						!externallySuspended &&
						deps.store.readScopeCheckpoint(scopeId)?.status === 'armed'
					) {
						observed = updatePianolaDecision(
							observed,
							{
								guard: { ...life.guard, configurationFingerprint },
							},
							deps.watch.now()
						);
					}
				}
				if (observed !== record) {
					deps.watch.recordDecision(observed);
					if (
						!options.dryRun &&
						observed.lifecycle!.status === 'waiting_human' &&
						record.lifecycle.status !== 'waiting_human'
					)
						await deps.watch.notify?.({
							kind: 'handoff_timeout',
							target,
							classification: record.classification,
							highRisk: record.classification.risk === 'high',
						});
				}
				if (observed.lifecycle!.acknowledgedAt)
					saved.state = {
						lastHandledMessageId: record.classification.evidence.messageId,
						pendingHandoff: null,
						pendingRetry: null,
					};
				const retryingRejectedAnswer =
					observed.lifecycle!.phase === 'answer' &&
					observed.lifecycle!.delivery === 'rejected' &&
					saved.state.pendingRetry?.messageId === record.classification.evidence.messageId;
				if (
					observed.lifecycle!.status !== 'done' &&
					!observed.lifecycle!.acknowledgedAt &&
					!retryingRejectedAnswer
				)
					pending = true;
				if (
					saved.unresolvedIntent?.decisionId === record.id &&
					(observed.lifecycle!.delivery === 'accepted' ||
						observed.lifecycle!.delivery === 'rejected' ||
						observed.lifecycle!.acknowledgedAt)
				)
					saved.unresolvedIntent = null;
			}
			saved.coverage = {
				observedAt: snapshot.capturedAt,
				status: saved.unresolvedIntent ? 'blocked' : 'covered',
				ownerScopeId: scopeId,
				reason: saved.unresolvedIntent ? 'Delivery outcome unknown' : 'Transcript cursor verified',
				nextActor: saved.unresolvedIntent ? 'operator' : 'worker',
				nextAction: saved.unresolvedIntent
					? 'Reconcile the native receipt or recipient transcript before any retry'
					: 'Continue bounded transcript monitoring',
			};
			if (saved.unresolvedIntent || pending || tab.busy) {
				saved.lastSeen = tab.cursor;
				persist();
				if (saved.unresolvedIntent)
					result.issues.push(`Delivery outcome unknown: ${tab.agentId}/${tab.tabId}`);
				continue;
			}
			let latestRecord: PianolaDecisionRecord | undefined;
			const deliveryGuard = (record: PianolaDecisionRecord): PianolaScopeDeliveryGuard => ({
				scopeId,
				configurationFingerprint,
				bindingFingerprint: saved.bindingFingerprint!,
				agentId: tab.agentId,
				tabId: tab.tabId,
				messageId: record.classification.evidence.messageId!,
				decisionId: record.id,
				cursor: tab.cursor!,
			});
			const guard = async (): Promise<PianolaScopeDeliveryGuard> => {
				const messageId = latestRecord?.classification.evidence.messageId;
				if (
					!messageId ||
					!actionableIds.has(messageId) ||
					!messages.some((message) => message.id === messageId && message.role === 'assistant') ||
					!tab.cursor
				)
					throw new Error('Missing post-baseline delivery evidence');
				if (options.shouldStop?.() || externallySuspended) throw new Error('Scope worker stopping');
				const currentTargets = deps.store.readSupervisorTargets();
				const currentScopes = scopesFrom(currentTargets);
				const currentScope = currentScopes.find((candidate) => candidate.id === scopeId);
				const current = await deps.readSnapshot();
				assertSnapshot(current);
				const currentTab = current.tabs.find(
					(candidate) => candidate.agentId === tab.agentId && candidate.tabId === tab.tabId
				);
				if (
					!currentScope?.enabled ||
					current.capturedAt < snapshot.capturedAt ||
					pianolaScopeConfigurationFingerprint(currentScope) !== configurationFingerprint ||
					!currentTab ||
					currentTab.busy ||
					!currentTab.cursorAvailable ||
					!sameCursor(currentTab.cursor, tab.cursor)
				)
					throw new Error('Scope or awaiting transcript changed before delivery');
				const winner = resolvePianolaScopeOwnership(
					currentTab,
					current.owners,
					currentScopes,
					currentTargets.filter((candidate) => candidate.kind === 'watch')
				);
				if (
					winner.kind !== 'scope' ||
					winner.scopeId !== scopeId ||
					bindingFingerprint(currentScope, tab.agentId, current.owners) !== saved.bindingFingerprint
				)
					throw new Error('Scope ownership changed before delivery');
				saved.unresolvedIntent = { decisionId: latestRecord!.id, messageId };
				persist();
				return {
					scopeId,
					configurationFingerprint,
					bindingFingerprint: saved.bindingFingerprint!,
					agentId: tab.agentId,
					tabId: tab.tabId,
					messageId,
					decisionId: latestRecord!.id,
					cursor: tab.cursor,
				};
			};
			const iteration = await runWatchIteration(
				messages,
				target,
				saved.state,
				{
					...deps.watch,
					recordDecision: (record) => {
						const current = deps.store
							.readDecisions()
							.find((candidate) => candidate.id === record.id);
						// Native admission owns receipt/actor changes. A worker outcome
						// must not overwrite a manager response received during its await.
						if (
							current?.lifecycle &&
							(current.deliveryStatus === 'admitted' || current.lifecycle.delivery !== 'intent')
						) {
							latestRecord = current;
							return;
						}
						latestRecord = startPianolaDecision(
							record,
							deliveryGuard(record),
							scope.managerAgentId,
							snapshot.owners.find((owner) => owner.id === tab.agentId)?.groupId ?? null
						);
						// A definitive refusal before native admission has no native
						// outcome writer. Keep it retryable instead of inventing an
						// interrupted/unknown delivery on the next poll.
						if (record.error && !record.dispatched)
							latestRecord = updatePianolaDecision(
								latestRecord,
								{ delivery: 'rejected' },
								record.timestamp
							);
						deps.watch.recordDecision(latestRecord);
					},
					dispatch: async (destination, answer) =>
						deliveryOutcome(await deps.dispatch(destination, answer, await guard())),
					requestJudgment: deps.requestJudgment
						? async (request) =>
								deliveryOutcome(await deps.requestJudgment!(request, await guard()))
						: undefined,
				},
				{ ...options, canActOnMessage: (messageId) => actionableIds.has(messageId) }
			);
			if (iteration.result.record?.error) {
				saved.coverage = {
					observedAt: snapshot.capturedAt,
					status: 'blocked',
					ownerScopeId: scopeId,
					reason: iteration.result.record.error.slice(0, 4000),
					nextActor: 'operator',
					nextAction:
						'Inspect native delivery refusal; bounded retry and explicit human escalation remain in force',
				};
			}
			saved.state = iteration.state;
			saved.baselineBusy = false;
			saved.lastSeen = tab.cursor;
			saved.unresolvedIntent = null;
			persist();
			result.iterations.push({ agentId: tab.agentId, tabId: tab.tabId, result: iteration.result });
		} catch (error) {
			if (saved.unresolvedIntent) {
				const record = deps.store
					.readDecisions()
					.find((candidate) => candidate.id === saved.unresolvedIntent!.decisionId);
				if (
					record?.lifecycle &&
					(record.lifecycle.delivery === 'intent' || record.lifecycle.delivery === 'unknown')
				)
					deps.watch.recordDecision(
						updatePianolaDecision(
							record,
							{
								delivery: 'unknown',
								status: 'blocked',
								nextActor: 'operator',
								nextAction: 'Reconcile the native receipt or recipient transcript before any retry',
							},
							deps.watch.now()
						)
					);
			}
			// Do not persist a cleared intent on failure: the durable copy is the
			// recovery authority even if the send succeeded before an outcome failed.
			result.issues.push(
				`${tab.agentId}/${tab.tabId}: ${error instanceof Error ? error.message : 'scope cycle failed'}`
			);
			if (persistenceFailed) throw error;
			saved.coverage = {
				observedAt: snapshot.capturedAt,
				status: 'blocked',
				ownerScopeId: scopeId,
				reason: (error instanceof Error ? error.message : 'Scope cycle failed').slice(0, 4000),
				nextActor: 'operator',
				nextAction: saved.unresolvedIntent
					? 'Reconcile the native receipt or recipient transcript before any retry'
					: 'Restore transcript access/cursor consistency; worker retries this tab on the next cycle',
			};
			persist();
			// Isolate an unavailable/stale tab, preserving any durable uncertain
			// intent, so another healthy tab in this scope can still make progress.
		}
	}
	return result;
}

/**
 * Synchronous native admission before invoking the renderer's normal send path.
 * Persist a claim first: duplicate admissions and unknown receipts stay blocked.
 * This is for rule answers; manager decisions use the decision lifecycle adapter.
 */
export function validatePianolaScopeDelivery(
	raw: unknown,
	snapshot: PianolaScopeSnapshot,
	store: Pick<
		PianolaFsStore,
		| 'readSupervisorTargets'
		| 'readScopeCheckpoint'
		| 'writeScopeCheckpoint'
		| 'readDecisions'
		| 'readRules'
		| 'appendDecision'
	>,
	requireIntent = true
) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Missing scope guard');
	const guard = raw as PianolaScopeDeliveryGuard;
	if (
		![
			'scopeId',
			'configurationFingerprint',
			'bindingFingerprint',
			'agentId',
			'tabId',
			'messageId',
			'decisionId',
		].every((key) => typeof (raw as Record<string, unknown>)[key] === 'string') ||
		!guard.cursor ||
		!isPianolaScopeCursor(guard.cursor)
	)
		throw new Error('Invalid scope guard');
	assertSnapshot(snapshot);
	const targets = store.readSupervisorTargets();
	const scopes = scopesFrom(targets);
	const scope = scopes.find((candidate) => candidate.id === guard.scopeId);
	const tab = snapshot.tabs.find(
		(candidate) => candidate.agentId === guard.agentId && candidate.tabId === guard.tabId
	);
	if (
		!scope?.enabled ||
		scope.selection.mode !== 'agents-and-groups' ||
		pianolaScopeConfigurationFingerprint(scope) !== guard.configurationFingerprint ||
		!tab ||
		tab.busy ||
		!tab.cursorAvailable ||
		!sameCursor(tab.cursor, guard.cursor)
	)
		throw new Error('Scope or pending ask changed');
	const owner = resolvePianolaScopeOwnership(
		tab,
		snapshot.owners,
		scopes,
		targets.filter((target) => target.kind === 'watch')
	);
	if (
		owner.kind !== 'scope' ||
		owner.scopeId !== scope.id ||
		bindingFingerprint(scope, tab.agentId, snapshot.owners) !== guard.bindingFingerprint
	)
		throw new Error('Scope ownership changed');
	const checkpoint = store.readScopeCheckpoint(scope.id);
	const saved = checkpoint?.tabs.find(
		(candidate) => candidate.agentId === tab.agentId && candidate.tabId === tab.tabId
	);
	if (
		!checkpoint ||
		checkpoint.status !== 'armed' ||
		checkpoint.configurationFingerprint !== guard.configurationFingerprint ||
		snapshot.capturedAt < (checkpoint.lastSnapshotAt ?? checkpoint.activatedAt) ||
		!saved ||
		saved.status !== 'active' ||
		saved.bindingFingerprint !== guard.bindingFingerprint ||
		(requireIntent &&
			(saved.unresolvedIntent?.decisionId !== guard.decisionId ||
				saved.unresolvedIntent.messageId !== guard.messageId ||
				saved.unresolvedIntent.admitted))
	)
		throw new Error('Scope intent missing or already admitted');
	const record = store.readDecisions().find((candidate) => candidate.id === guard.decisionId);
	if (
		!record ||
		record.dryRun ||
		record.agentId !== tab.agentId ||
		record.tabId !== tab.tabId ||
		record.classification.evidence.messageId !== guard.messageId
	)
		throw new Error('Missing pending decision');
	if (record.lifecycle && canonicalJson(record.lifecycle.guard) !== canonicalJson(guard))
		throw new Error('Decision recipient binding changed');
	return { guard, scope, tab, checkpoint, saved, record };
}

/** Claim synchronously on the desktop before its normal renderer send. */
export function admitPianolaScopeReply(
	raw: unknown,
	answer: string,
	snapshot: PianolaScopeSnapshot,
	store: Parameters<typeof validatePianolaScopeDelivery>[2],
	judgment = false
): PianolaScopeDeliveryGuard {
	const { guard, tab, checkpoint, saved, record } = validatePianolaScopeDelivery(
		raw,
		snapshot,
		store
	);
	if (
		store
			.readDecisions()
			.some(
				(candidate) =>
					candidate.agentId === tab.agentId &&
					candidate.tabId === tab.tabId &&
					candidate.classification.evidence.messageId === guard.messageId &&
					!candidate.dryRun &&
					candidate.lifecycle?.delivery !== 'rejected' &&
					(candidate.dispatched || candidate.deliveryStatus === 'admitted')
			)
	)
		throw new Error('Ask already admitted or answered');
	if (judgment) {
		if (
			!record.lifecycle ||
			record.lifecycle.phase !== 'judgment' ||
			record.lifecycle.delivery !== 'intent' ||
			record.classification.risk === 'high'
		)
			throw new Error('Missing eligible judgment intent');
	} else {
		if (
			record.dispatched ||
			record.decision.action !== 'auto_answer' ||
			record.decision.answer !== answer
		)
			throw new Error('Missing rule answer intent');
		const currentDecision = decide(record.classification, store.readRules(), {
			tabId: tab.tabId,
			agentId: tab.agentId,
			groupId: snapshot.owners.find((owner) => owner.id === tab.agentId)!.groupId,
			projectPath: snapshot.owners.find((candidate) => candidate.id === tab.agentId)!.cwd,
		});
		if (
			currentDecision.action !== 'auto_answer' ||
			currentDecision.matchedRuleId !== record.decision.matchedRuleId ||
			currentDecision.answer !== answer
		)
			throw new Error('Rule answer no longer authorized');
	}
	store.appendDecision({ ...record, deliveryStatus: 'admitted' });
	saved.unresolvedIntent!.admitted = true;
	store.writeScopeCheckpoint(checkpoint);
	return guard;
}
