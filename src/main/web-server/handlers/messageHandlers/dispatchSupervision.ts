/** Route optional supervision without making it a global delegation permission. */
import { hostCallerRuns } from '../../../agent-run/caller-identity';
import * as store from '../../../pianola/pianola-store-main';
import { getSettingsStore } from '../../../stores/getters';
import { resolveEncoreFeatures } from '../../../../shared/encoreFeatureDefaults';
import { resolvePianolaScopeOwnership } from '../../../../shared/pianola/pianola-scope';
import { pianolaScopeSnapshotFromDesktop } from '../../../../shared/pianola/pianola-scope-cycle';
import type { PianolaDispatchReceipt } from '../../../../shared/pianola/pianola-dispatch';
import type { MessageHandlerContext, WebClient } from './types';

export function dispatchSupervision(
	ctx: MessageHandlerContext,
	client: WebClient,
	targetAgentId: string,
	dispatchId: string,
	targetTabId?: string
): { managed: boolean; receipt?: PianolaDispatchReceipt; error?: string } {
	const caller = hostCallerRuns.resolve(client);
	if (!caller && !hostCallerRuns.isRunClient(client)) return { managed: false };
	const receipt: PianolaDispatchReceipt = {
		version: 1,
		dispatchId,
		targetAgentId,
		targetTabId,
		supervision: 'unavailable',
		outcome: 'not-started',
	};
	const refuse = (
		error: string,
		supervision: PianolaDispatchReceipt['supervision'] = 'unavailable'
	) => ({
		managed: true,
		receipt: { ...receipt, supervision, outcome: 'rejected' as const },
		error,
	});
	if (!caller) return refuse('CallerRunUnavailable');
	try {
		caller.assertActive();
		// Never route a previously journaled release through the ordinary send path,
		// even if supervision was switched off since its acknowledgment was lost.
		const prior = store.readDispatchAdmission(dispatchId);
		if (prior) return { managed: true };
		if (!resolveEncoreFeatures(getSettingsStore().get('encoreFeatures')).pianola)
			return { managed: false, receipt: { ...receipt, supervision: 'feature-off' } };
		const targets = store.readSupervisorTargets();
		const scopes = targets
			.filter((t) => t.kind === 'watch-scope' && t.selection && t.managerAgentId)
			.map((t) => ({ ...t, selection: t.selection!, managerAgentId: t.managerAgentId! }));
		if (!scopes.some((s) => s.managerAgentId === caller.run.agentId))
			return { managed: false, receipt: { ...receipt, supervision: 'unmanaged' } };
		const snapshot = pianolaScopeSnapshotFromDesktop({
			...ctx.callbacks.listDesktopSessions?.(),
			success: true,
		});
		if (!snapshot.complete) return refuse('PianolaSnapshotUnavailable');
		const tab = targetTabId
			? snapshot.tabs.find((t) => t.agentId === targetAgentId && t.tabId === targetTabId)
			: { agentId: targetAgentId, tabId: '', paused: false, consult: false, ephemeral: false };
		if (!tab) return refuse('DispatchTargetUnavailable');
		const ownership = resolvePianolaScopeOwnership(
			tab,
			snapshot.owners,
			scopes,
			targets.filter((t) => t.kind === 'watch')
		);
		// Determine potential coverage using the same native membership resolver.
		// Removing vetoes here only detects management; it never authorizes a send.
		const potential = resolvePianolaScopeOwnership(
			{ ...tab, paused: false },
			snapshot.owners,
			scopes.map((s) => ({
				...s,
				enabled: true,
				selection: { ...s.selection, excludedAgentIds: [] },
			})),
			[]
		);
		const scopeId =
			ownership.kind === 'scope'
				? ownership.scopeId
				: potential.kind === 'scope'
					? potential.scopeId
					: undefined;
		const scope = scopes.find((s) => s.id === scopeId);
		if (!scope || scope.managerAgentId !== caller.run.agentId)
			return { managed: false, receipt: { ...receipt, supervision: 'unmanaged' } };
		receipt.scopeId = scope.id;
		if (ownership.kind !== 'scope')
			return refuse('PianolaTargetExcluded', tab.paused ? 'paused' : 'excluded');
		if (scope.delegationPolicy?.enabled === false) return refuse('PianolaPolicyPaused', 'paused');
		const checkpoint = store.readScopeCheckpoint(scope.id);
		if (
			checkpoint &&
			(checkpoint.status !== 'armed' ||
				checkpoint.tabs.some(
					(t) => t.agentId === targetAgentId && t.tabId === targetTabId && t.status !== 'active'
				))
		)
			return refuse('PianolaCheckpointSuspended', 'paused');
		return { managed: true, receipt };
	} catch (error) {
		return refuse(error instanceof Error ? error.message : 'PianolaAdmissionUnavailable');
	}
}
