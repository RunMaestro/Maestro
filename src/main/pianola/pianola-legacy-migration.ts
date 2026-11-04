/** Host-only handover, published by one canonical supervisor-registry mutation.
 * Checkpoints precede publication: an interrupted preparation grants no new owner.
 * Observation consent is supplied by the owner adapter; answer rules are untouched.
 */
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
	status: 'migrated' | 'already-migrated' | 'registered' | 'NeedsConfiguration';
	scopeId: string;
	watchIds: string[];
	reason?: string;
};

type MigrationStore = Pick<
	PianolaFsStore,
	'updateSupervisorTargetsAsync' | 'readScopeCheckpoint' | 'writeScopeCheckpoint' | 'readDecisions'
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
	const scope = {
		...cleanTarget,
		selection: target.selection,
		managerAgentId: target.managerAgentId,
	};
	await deps.store.updateSupervisorTargetsAsync((current) => {
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
				canonicalJson(existing.delegationPolicy ?? null) !==
					canonicalJson(scope.delegationPolicy ?? null) ||
				pianolaScopeConfigurationFingerprint({
					...existing,
					selection: existing.selection,
					managerAgentId: existing.managerAgentId,
				}) !== pianolaScopeConfigurationFingerprint(scope))
		) {
			result.reason = 'Scope configuration changed; reconcile the existing selection first';
			return current;
		}
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
			const unfenced = active.filter((watch) => !deps.canFence(watch.id));
			if (unfenced.length) {
				result.watchIds = unfenced.map((watch) => watch.id);
				result.reason =
					'Legacy owner lacks a host-verified send fence; restart its supervised worker before takeover';
				return current;
			}
		}
		if (existing?.legacyMigration && !active.length) {
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
		if (legacy.length) {
			// Check the registry that would actually be published, after retiring
			// legacy watches. An overlapping older scope has no handover baseline
			// or receipt and could replay a historical busy question on idle.
			const scopes = next.flatMap((entry) =>
				entry.kind === 'watch-scope' && entry.selection && entry.managerAgentId
					? [{ ...entry, selection: entry.selection, managerAgentId: entry.managerAgentId }]
					: []
			);
			const watches = next.filter((entry) => entry.kind === 'watch');
			for (const tab of snapshot.tabs.filter((tab) => matches(tab.agentId, tab.tabId))) {
				const owner = resolvePianolaScopeOwnership(tab, snapshot.owners, scopes, watches);
				if (owner.kind === 'scope' && owner.scopeId !== scope.id) {
					result.reason = `Legacy takeover would assign ${tab.agentId}/${tab.tabId} to scope ${owner.scopeId} without a handover baseline; reconcile overlapping scopes first`;
					return current;
				}
			}
		}
		if (legacy.length) {
			const checkpoint = deps.store.readScopeCheckpoint(scope.id) ?? {
				version: 1 as const,
				scopeId: scope.id,
				configurationFingerprint: pianolaScopeConfigurationFingerprint(scope),
				activatedAt: snapshot.capturedAt,
				status: 'armed' as const,
				tabs: [],
			};
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
				if (saved && !takenOver) continue;
				if (!tab.cursorAvailable)
					throw new Error(`Migration cursor unavailable: ${tab.agentId}/${tab.tabId}`);
				const baseline = {
					agentId: tab.agentId,
					tabId: tab.tabId,
					bindingFingerprint: pianolaScopeBindingFingerprint(scope, tab.agentId, snapshot.owners),
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
			checkpoint.lastSnapshotAt = snapshot.capturedAt;
			deps.store.writeScopeCheckpoint(checkpoint);
		}
		result = {
			status: active.length ? 'migrated' : 'registered',
			scopeId: scope.id,
			watchIds: replacement.legacyMigration?.watchIds ?? [],
		};
		return next;
	});
	return result;
}
