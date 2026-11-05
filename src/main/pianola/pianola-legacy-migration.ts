/** Host-only handover, published by one canonical supervisor-registry mutation.
 * Checkpoints precede publication: an interrupted preparation grants no new owner.
 * Observation consent is supplied by the owner adapter; answer rules are untouched.
 */
import { createHash } from 'node:crypto';
import type { RulesLoadResult } from '../../shared/pianola/storage';
import type { PianolaFsStore } from '../../shared/pianola/fs-store';
import type { PianolaSupervisedTarget } from '../../shared/pianola/storage';
import { canonicalJson } from '../../shared/canonicalJson';
import { resolvePianolaScopeOwnership } from '../../shared/pianola/pianola-scope';
import {
	pianolaScopeBindingFingerprint,
	pianolaScopeConfigurationFingerprint,
	type PianolaScopeSnapshot,
} from '../../shared/pianola/pianola-scope-cycle';
import { initialWatchState } from '../../shared/pianola/pianola-watcher';

export type PianolaLegacyMigrationResult = {
	status:
		| 'migrated'
		| 'already-migrated'
		| 'registered'
		| 'NeedsConfiguration'
		| 'Denied'
		| 'Unknown';
	scopeId: string;
	watchIds: string[];
	reason?: string;
};

type MigrationStore = Pick<
	PianolaFsStore,
	| 'updateSupervisorTargetsAsync'
	| 'readScopeCheckpoint'
	| 'withScopeCheckpointLockAsync'
	| 'readDecisions'
>;

export async function migratePianolaLegacyWatches(
	target: PianolaSupervisedTarget,
	deps: {
		store: MigrationStore;
		/** Synchronous native census INSIDE the registry lock, never caller-supplied metadata. */
		snapshot: () => PianolaScopeSnapshot;
		/** True only for a host-owned child whose proof is checked on every native send. */
		canFence: (watchId: string) => boolean;
		featureEnabled: () => boolean;
		/** Host configuration adapter, evaluated under the same registry lock. */
		prepare?: (
			current: PianolaSupervisedTarget[],
			snapshot: PianolaScopeSnapshot
		) => PianolaSupervisedTarget | string;
	}
): Promise<PianolaLegacyMigrationResult> {
	let result: PianolaLegacyMigrationResult = {
		status: 'NeedsConfiguration',
		scopeId: target.id,
		watchIds: [],
		reason: 'Select native agents/groups and an owner-authorized manager policy',
	};
	if (
		target.kind !== 'watch-scope' ||
		target.selection?.mode !== 'agents-and-groups' ||
		!target.managerAgentId
	)
		return result;
	const cleanTarget = { ...target };
	delete cleanTarget.legacyMigration;
	delete cleanTarget.migratedToScopeId;
	let scope = {
		...cleanTarget,
		selection: target.selection,
		managerAgentId: target.managerAgentId,
	};
	let lockedScopeId = scope.id;
	const migrateLocked = (
		current: PianolaSupervisedTarget[],
		write: PianolaFsStore['writeScopeCheckpoint']
	) => {
		if (!deps.featureEnabled()) {
			result.reason = 'Pianola is disabled';
			return current;
		}
		const snapshot = deps.snapshot();
		if (
			!snapshot.complete ||
			!Number.isSafeInteger(snapshot.capturedAt) ||
			snapshot.capturedAt < 0 ||
			new Set(snapshot.owners.map((owner) => owner.id)).size !== snapshot.owners.length ||
			new Set(current.map((entry) => entry.id)).size !== current.length
		) {
			result.reason = 'Native census unavailable; legacy ownership is unchanged';
			return current;
		}
		if (deps.prepare) {
			const prepared = deps.prepare(current, snapshot);
			if (typeof prepared === 'string') {
				result.reason = prepared;
				return current;
			}
			if (prepared.selection?.mode !== 'agents-and-groups' || !prepared.managerAgentId) {
				result.reason = 'Select native agents/groups and a manager';
				return current;
			}
			scope = {
				...prepared,
				selection: prepared.selection,
				managerAgentId: prepared.managerAgentId!,
			};
			result.scopeId = scope.id;
		}
		// Automation can propose a different ID for an existing standing scope.
		// Resolve that host identity without mutating, then reacquire its own lock.
		if (scope.id !== lockedScopeId) return current;
		const matches = (agentId: string, tabId: string) =>
			resolvePianolaScopeOwnership(
				{ agentId, tabId, paused: false, consult: false, ephemeral: false },
				snapshot.owners,
				[{ ...scope, enabled: true }],
				[]
			).kind === 'scope';
		const legacy = current.filter(
			(watch) =>
				watch.kind === 'watch' &&
				!watch.migratedToScopeId &&
				watch.agentId &&
				watch.tabId &&
				matches(watch.agentId, watch.tabId)
		);
		const active = legacy.filter((watch) => watch.enabled);
		const existing = current.find((entry) => entry.id === scope.id);
		if (
			existing &&
			(existing.kind !== 'watch-scope' ||
				!existing.selection ||
				!existing.managerAgentId ||
				(!deps.prepare &&
					canonicalJson(existing.delegationPolicy ?? null) !==
						canonicalJson(scope.delegationPolicy ?? null)) ||
				(!deps.prepare &&
					pianolaScopeConfigurationFingerprint({
						...existing,
						selection: existing.selection,
						managerAgentId: existing.managerAgentId,
					}) !== pianolaScopeConfigurationFingerprint(scope)))
		) {
			result.reason = 'Scope configuration changed; reconcile the existing selection first';
			return current;
		}
		const selectionChanged =
			!!existing?.selection &&
			!!existing.managerAgentId &&
			pianolaScopeConfigurationFingerprint({
				...existing,
				selection: existing.selection,
				managerAgentId: existing.managerAgentId,
			}) !== pianolaScopeConfigurationFingerprint(scope);
		const previouslySelected = (agentId: string, tabId: string) =>
			!!existing?.selection &&
			!!existing.managerAgentId &&
			resolvePianolaScopeOwnership(
				{ agentId, tabId, paused: false, consult: false, ephemeral: false },
				snapshot.owners,
				[
					{
						...existing,
						enabled: true,
						selection: existing.selection,
						managerAgentId: existing.managerAgentId,
					},
				],
				[]
			).kind === 'scope';
		if (legacy.length) {
			const manager = snapshot.owners.filter(
				(owner) => owner.id === scope.managerAgentId && !owner.remote
			);
			if (
				manager.length !== 1 ||
				!scope.delegationPolicy ||
				scope.delegationPolicy.managerAgentId !== scope.managerAgentId
			) {
				result.reason =
					'Legacy takeover requires a unique native manager and an owner-authorized standing policy';
				return current;
			}
			// Old manager prompts contained an unguarded dispatch command, with no
			// recipient-bound receipt/lifecycle. Killing the watcher cannot revoke
			// that independent manager turn. Never guess that it has completed.
			const unboundHandoff = deps.store
				.readDecisions()
				.find(
					(record) =>
						!record.dryRun &&
						!record.lifecycle &&
						record.decision.action === 'escalate' &&
						record.decision.reason.startsWith('handed off to Pianola for ') &&
						legacy.some((watch) => watch.agentId === record.agentId && watch.tabId === record.tabId)
				);
			if (unboundHandoff) {
				result.reason = `Legacy manager handoff ${unboundHandoff.id} has no revocable answer binding; reconcile it before takeover`;
				return current;
			}
			const pendingDelivery = deps.store
				.readDecisions()
				.find(
					(record) =>
						!record.dryRun &&
						legacy.some(
							(watch) => watch.agentId === record.agentId && watch.tabId === record.tabId
						) &&
						(record.lifecycle?.delivery === 'unknown' ||
							record.lifecycle?.delivery === 'intent' ||
							(record.lifecycle?.delivery === 'accepted' &&
								!record.lifecycle.acknowledgedAt &&
								record.lifecycle.status !== 'done'))
				);
			if (pendingDelivery) {
				result.reason = `Legacy delivery ${pendingDelivery.id} requires acknowledgment or outcome reconciliation before takeover`;
				return current;
			}
			const unfenced = active.filter((watch) => !deps.canFence(watch.id));
			if (unfenced.length) {
				result.watchIds = unfenced.map((watch) => watch.id);
				result.reason =
					'Legacy owner lacks a host-verified send fence; restart its supervised worker before takeover';
				return current;
			}
		}
		if (existing && !legacy.length && canonicalJson(existing) === canonicalJson(scope)) {
			result = {
				status: existing.legacyMigration ? 'already-migrated' : 'registered',
				scopeId: existing.id,
				watchIds: existing.legacyMigration?.watchIds ?? [],
			};
			return current;
		}
		if (
			existing?.legacyMigration &&
			!active.length &&
			!selectionChanged &&
			canonicalJson(existing.delegationPolicy ?? null) ===
				canonicalJson(scope.delegationPolicy ?? null)
		) {
			result = {
				status: 'already-migrated',
				scopeId: scope.id,
				watchIds: existing.legacyMigration.watchIds,
			};
			// A label is presentation only and is excluded from the consent
			// fingerprint. Save it without changing the paused state, receipt,
			// worker settings or checkpoint of the existing scope.
			return current.map((entry) =>
				entry.id === existing.id
					? { ...existing, selection: { ...existing.selection!, label: scope.selection.label } }
					: entry
			);
		}
		// Preserve an explicitly paused scope and each disabled concrete tab watch.
		const replacement = {
			...scope,
			enabled: existing?.enabled ?? scope.enabled,
			...(existing?.legacyMigration ? { legacyMigration: existing.legacyMigration } : {}),
		};
		if (legacy.length) {
			replacement.legacyMigration = {
				version: 1,
				watchIds: [
					...new Set([
						...(existing?.legacyMigration?.watchIds ?? []),
						...active.map((watch) => watch.id),
					]),
				],
				completedAt: snapshot.capturedAt,
			};
		}
		const next = current.map((entry) =>
			active.some((watch) => watch.id === entry.id)
				? { ...entry, enabled: false, migratedToScopeId: scope.id }
				: entry.id === scope.id
					? replacement
					: entry
		);
		if (!existing) next.push(replacement);
		if (
			selectionChanged ||
			legacy.length ||
			!existing ||
			(!!deps.prepare && !existing.delegationPolicy)
		) {
			// Check the registry that would actually be published, after retiring
			// legacy watches. An overlapping older scope has no handover baseline
			// or receipt and could replay a historical busy question on idle.
			const scopes = next.flatMap((entry) =>
				entry.kind === 'watch-scope' && entry.selection && entry.managerAgentId
					? [
							{
								...entry,
								enabled: true,
								selection: entry.selection,
								managerAgentId: entry.managerAgentId,
							},
						]
					: []
			);
			const watches = next.filter((entry) => entry.kind === 'watch');
			for (const tab of snapshot.tabs.filter(
				(tab) =>
					matches(tab.agentId, tab.tabId) ||
					(selectionChanged && previouslySelected(tab.agentId, tab.tabId))
			)) {
				// Resolve the potential winner after resume, not current send authority.
				// Temporary scope/tab pauses must not hide a missing handover baseline.
				const owner = resolvePianolaScopeOwnership(
					{ ...tab, paused: false },
					snapshot.owners,
					scopes,
					watches
				);
				if (owner.kind === 'scope' && owner.scopeId !== scope.id) {
					result.reason = `Legacy takeover would assign ${tab.agentId}/${tab.tabId} to scope ${owner.scopeId} without a handover baseline; reconcile overlapping scopes first`;
					return current;
				}
			}
		}
		if (
			selectionChanged ||
			legacy.length ||
			!existing ||
			(!!deps.prepare && !existing.delegationPolicy)
		) {
			const checkpoint = deps.store.readScopeCheckpoint(scope.id) ?? {
				version: 1 as const,
				scopeId: scope.id,
				configurationFingerprint: pianolaScopeConfigurationFingerprint(scope),
				activatedAt: snapshot.capturedAt,
				status: 'armed' as const,
				tabs: [],
			};
			if (!selectionChanged && checkpoint.tabs.some((tab) => tab.unresolvedIntent)) {
				result.reason = 'Scope has an unresolved delivery; reconcile its outcome before takeover';
				return current;
			}
			if (snapshot.capturedAt < (checkpoint.lastSnapshotAt ?? checkpoint.activatedAt))
				throw new Error('Migration clock precedes scope checkpoint');
			// All existing chats are historical at handover, including busy streams.
			// Never expose the old unanswered question by setting baselineBusy=true.
			for (const tab of snapshot.tabs.filter((tab) => matches(tab.agentId, tab.tabId))) {
				const saved = checkpoint.tabs.find(
					(entry) => entry.agentId === tab.agentId && entry.tabId === tab.tabId
				);
				const takenOver = active.some(
					(watch) => watch.agentId === tab.agentId && watch.tabId === tab.tabId
				);
				if (
					saved &&
					!takenOver &&
					(!selectionChanged ||
						(previouslySelected(tab.agentId, tab.tabId) &&
							existing?.managerAgentId === scope.managerAgentId))
				)
					continue;
				if (!tab.cursorAvailable)
					throw new Error(`Migration cursor unavailable: ${tab.agentId}/${tab.tabId}`);
				const baseline = {
					agentId: tab.agentId,
					tabId: tab.tabId,
					bindingFingerprint: pianolaScopeBindingFingerprint(scope, tab.agentId, snapshot.owners),
					emptyEnrollment: tab.enrollment,
					baseline: tab.cursor,
					baselineBusy: false,
					lastSeen: tab.cursor,
					state: initialWatchState(),
					status: tab.paused ? ('suspended' as const) : ('active' as const),
					unresolvedIntent: saved?.unresolvedIntent ?? null,
				};
				if (saved) Object.assign(saved, baseline);
				else checkpoint.tabs.push(baseline);
			}
			checkpoint.configurationFingerprint = pianolaScopeConfigurationFingerprint(scope);
			checkpoint.enrollmentRevision = (checkpoint.enrollmentRevision ?? 0) + 1;
			checkpoint.lastSnapshotAt = snapshot.capturedAt;
			write(checkpoint, true);
		}
		result = {
			status: active.length ? 'migrated' : 'registered',
			scopeId: scope.id,
			watchIds: replacement.legacyMigration?.watchIds ?? [],
		};
		return next;
	};
	// Checkpoint then registry: capture native state and publish both commits
	// synchronously after both lock waits, with no stale census across an await.
	for (let attempt = 0; attempt < 2; attempt++) {
		lockedScopeId = scope.id;
		await deps.store.withScopeCheckpointLockAsync(lockedScopeId, (write) =>
			deps.store.updateSupervisorTargetsAsync((current) => migrateLocked(current, write))
		);
		if (scope.id === lockedScopeId) return result;
	}
	throw new Error('Scope identity changed; reload before configuration');
}

/** Shared native UI / bridge configuration path. Only a verified human owner may
 * create or change observation consent. Automation can reconcile the exact standing
 * selection already authorized on the host, never change its policy or pause.
 * This does not grant answer authority or delegated configuration rights.
 */
export async function configurePianolaScope(
	target: PianolaSupervisedTarget,
	deps: Parameters<typeof migratePianolaLegacyWatches>[1] & {
		ownerAuthorized: () => boolean;
		readRules: () => RulesLoadResult;
		/** One-use host consent precondition, checked inside the registry lock. */
		approvalValid?: (current: PianolaSupervisedTarget[]) => boolean;
	}
): Promise<PianolaLegacyMigrationResult> {
	return migratePianolaLegacyWatches(target, {
		...deps,
		prepare: (current, snapshot) => {
			if (deps.approvalValid && !deps.approvalValid(current))
				return 'Owner approval expired or configuration changed';
			const ownerAuthorized = deps.ownerAuthorized();
			if (
				ownerAuthorized &&
				target.selection?.mode === 'agents-and-groups' &&
				target.selection.futureLocalAgents
			) {
				const previous = current.find((entry) => entry.id === target.id)?.selection;
				const baseline =
					previous?.mode === 'agents-and-groups' && previous.futureLocalAgents
						? previous.futureAgentBaselineIds
						: snapshot.owners.map((owner) => owner.id).sort();
				if (!baseline || baseline.length > 500)
					return 'Future-agent baseline unavailable or exceeds supported selection size';
				target = {
					...target,
					selection: { ...target.selection, futureAgentBaselineIds: baseline },
				};
			}
			// Non-owner callers may only reconcile a stored future selection. Its
			// host-stamped baseline is part of the fingerprint, not CLI authority.
			if (
				!ownerAuthorized &&
				target.selection?.mode === 'agents-and-groups' &&
				target.selection.futureLocalAgents
			) {
				const previous = current.find((entry) => entry.id === target.id)?.selection;
				if (
					previous?.mode === 'agents-and-groups' &&
					previous.futureLocalAgents &&
					previous.futureAgentBaselineIds
				) {
					target = {
						...target,
						selection: {
							...target.selection,
							futureAgentBaselineIds: previous.futureAgentBaselineIds,
						},
					};
				}
			}
			const requestedFingerprint = pianolaScopeConfigurationFingerprint({
				...target,
				selection: target.selection!,
				managerAgentId: target.managerAgentId!,
			});
			const matches = current.filter(
				(entry) =>
					entry.kind === 'watch-scope' &&
					entry.selection &&
					entry.managerAgentId &&
					pianolaScopeConfigurationFingerprint({
						...entry,
						selection: entry.selection,
						managerAgentId: entry.managerAgentId,
					}) === requestedFingerprint
			);
			const byId = current.find((entry) => entry.id === target.id);
			if (matches.length > 1)
				return 'Ambiguous standing scope selection; reconcile duplicates on the host';
			const existing = byId ?? matches[0];
			if (byId && (!ownerAuthorized || byId.kind !== 'watch-scope') && !matches.includes(byId))
				return 'Scope configuration changed; reconcile the existing selection first';
			if (
				!ownerAuthorized &&
				(!existing?.delegationPolicy ||
					!existing.delegationPolicy.enabled ||
					existing.delegationPolicy.managerAgentId !== target.managerAgentId ||
					!matches.includes(existing))
			)
				return 'Owner-authorized standing selection required; save this exact selection in the native owner UI first';
			const managers = snapshot.owners.filter(
				(owner) => owner.id === target.managerAgentId && !owner.remote
			);
			if (managers.length !== 1) return 'Select a unique native manager on the host';
			const rules = deps.readRules();
			if (rules.malformed)
				return 'Pianola rules unavailable; repair the host rules before configuration';
			const ruleSetRevision = createHash('sha256').update(canonicalJson(rules.rules)).digest('hex');
			if (!ownerAuthorized && existing?.delegationPolicy?.ruleSetRevision !== ruleSetRevision)
				return 'Owner approval required for changed Pianola rules; save this scope in the native owner UI or request owner approval';
			// Renewal changes admission authority, not answer rules or enrollment.
			// Older tasks keep their original policy fingerprint and cannot adopt it.
			const policyChanged =
				existing?.delegationPolicy?.managerAgentId !== target.managerAgentId ||
				existing?.delegationPolicy?.ruleSetRevision !== ruleSetRevision;
			const policy = existing?.delegationPolicy
				? {
						...existing.delegationPolicy,
						...(ownerAuthorized && policyChanged
							? {
									managerAgentId: target.managerAgentId!,
									ruleSetRevision,
									revision: existing.delegationPolicy.revision + 1,
								}
							: {}),
					}
				: {
						version: 1 as const,
						revision: 1,
						enabled: true,
						managerAgentId: managers[0].id,
						coverage: 'selected-agents' as const,
						ruleSetRevision,
					};
			// A CLI request is only a trigger for the stored consent. Its ID, label,
			// enabled flag, timestamps, worker options and policy confer no rights.
			return existing
				? {
						...existing,
						selection: ownerAuthorized ? target.selection! : existing.selection,
						managerAgentId: ownerAuthorized ? target.managerAgentId : existing.managerAgentId,
						delegationPolicy: policy,
					}
				: { ...target, delegationPolicy: policy };
		},
	});
}
