/** Host-side mention identity and step journal. Uses the existing planner and peer rules. */
import { createHash, randomUUID } from 'crypto';
import { canonicalJson } from '../../shared/canonicalJson';
import { resolvePeerRoster } from '../../shared/peerAgents';
import {
	buildAgentMentionSuggestions,
	planMentions,
} from '../../shared/maestro-lib/mentions/roster';
import type { AgentRecord, GroupRecord } from '../../shared/maestro-lib/store/records';
import type { PianolaQueueItem, PianolaQueueRouting } from '../../shared/pianola/pianola-dispatch';

export interface QueueRoutingSnapshot {
	agents: readonly AgentRecord[];
	groups: readonly GroupRecord[];
}

function recipientFingerprint(agent: AgentRecord): string {
	// Bind actual launch settings, not streaming/log/selection state. A renamed or
	// replaced recipient is not silently retargeted even if its token resolves again.
	const fields = [
		'id',
		'createdAt',
		'name',
		'toolType',
		'cwd',
		'fullPath',
		'groupId',
		'parentSessionId',
		'customPath',
		'customArgs',
		'customEnvVars',
		'customModel',
		'customEffort',
		'customContextWindow',
		'enableMaestroP',
		'maestroPMode',
		'maestroPPath',
		'sessionSshRemoteConfig',
	];
	return createHash('sha256')
		.update(canonicalJson(Object.fromEntries(fields.map((k) => [k, agent[k]]))))
		.digest('hex');
}

export function prepareQueueRouting(
	item: PianolaQueueItem,
	sourceAgentId: string,
	snapshot: QueueRoutingSnapshot
): PianolaQueueRouting | undefined {
	const { agents, groups } = snapshot;
	const plan = planMentions(item.text, agents, groups, sourceAgentId);
	if (!plan) {
		if (item.crossAgentMention) throw new Error('DispatchRoutingRecipientUnavailable');
		return;
	}
	if (!item.crossAgentMention) throw new Error('DispatchRoutingIntentMismatch');
	const source = agents.find((a) => a.id === sourceAgentId);
	if (!source) throw new Error('DispatchRoutingSourceUnavailable');
	const routing = item.mentionRouting ?? plan.routing;
	const peers = resolvePeerRoster(source, agents);
	const suggestions = buildAgentMentionSuggestions(agents, groups, sourceAgentId).filter(
		(s) => s.kind === 'agent'
	);
	const targets = plan.targetAgentIds.map((agentId) => {
		const target = agents.find((a) => a.id === agentId)!;
		const token = suggestions.find((s) => s.targetSessionId === agentId)?.value.toLowerCase();
		if (
			!token ||
			suggestions.filter((s) => s.value.toLowerCase() === token).length !== 1 ||
			!Number.isSafeInteger(target.createdAt)
		)
			throw new Error('DispatchRoutingRecipientAmbiguous');
		const peer = peers.find((p) => p.sessionId === agentId);
		if (!(routing === 'handoff' ? peer?.write : peer?.read))
			throw new Error('DispatchRoutingPeerDenied');
		return { agentId, fingerprint: recipientFingerprint(target) };
	});
	const kind = routing === 'handoff' ? 'handoff' : 'consult';
	const steps: PianolaQueueRouting['steps'] = targets.map((t) => ({
		kind,
		targetAgentId: t.agentId,
		requestId: randomUUID(),
		status: 'prepared',
	}));
	if (routing !== 'only')
		steps.push({
			kind: 'local',
			targetAgentId: sourceAgentId,
			requestId: randomUUID(),
			status: 'prepared',
		});
	return { routing, targets, steps };
}

export function assertQueueRouting(
	pinned: PianolaQueueRouting,
	item: PianolaQueueItem,
	sourceAgentId: string,
	snapshot: QueueRoutingSnapshot
): void {
	const current = prepareQueueRouting(item, sourceAgentId, snapshot);
	if (
		!current ||
		canonicalJson({ routing: current.routing, targets: current.targets }) !==
			canonicalJson({ routing: pinned.routing, targets: pinned.targets })
	) {
		throw new Error('DispatchRoutingRecipientChanged');
	}
}

/** Native release closures only. This map is intentionally process-local: reading
 * an old admission after a restart cannot reconstruct permission to send. */
const consultReleases = new Map<
	string,
	{
		sourceAgentId: string;
		sourceTabId: string;
		generation: string;
		guard(): void;
		revoke(): void;
		start(
			targetAgentId: string,
			opts: Omit<
				import('../cross-agent/cross-agent-router').StartCrossAgentRequestOptions,
				'nativeAdmission'
			>
		): Promise<{ requestId: string }>;
	}
>();

export function bindQueueConsultRelease(
	dispatchId: string,
	release: NonNullable<ReturnType<typeof consultReleases.get>>
): void {
	sweepQueueConsultReleases();
	release.guard();
	forgetQueueConsultRelease(dispatchId);
	// Fail closed under pressure: eviction removes only future send authority,
	// never the ConsultService's supervision of already claimed children.
	while (consultReleases.size >= 256)
		forgetQueueConsultRelease(consultReleases.keys().next().value!);
	consultReleases.set(dispatchId, release);
}

export function startReleasedQueueConsult(
	locator: { dispatchId: string; generation: string },
	sourceAgentId: string,
	sourceTabId: string,
	targetAgentId: string,
	opts: Omit<
		import('../cross-agent/cross-agent-router').StartCrossAgentRequestOptions,
		'nativeAdmission'
	>
): Promise<{ requestId: string }> {
	sweepQueueConsultReleases();
	const release = consultReleases.get(locator.dispatchId);
	if (
		!release ||
		release.sourceAgentId !== sourceAgentId ||
		release.sourceTabId !== sourceTabId ||
		release.generation !== locator.generation
	)
		return Promise.reject(new Error('DispatchRoutingReleaseUnavailable'));
	return release.start(targetAgentId, opts);
}

export function forgetQueueConsultRelease(dispatchId: string): void {
	const release = consultReleases.get(dispatchId);
	consultReleases.delete(dispatchId);
	release?.revoke();
}

/** Called by existing supervisor health/reconcile/stop boundaries; no new timer.
 * Expired, cancelled or invalid policy releases cannot retain service closures. */
export function sweepQueueConsultReleases(dispose = false): void {
	for (const [id, release] of consultReleases) {
		if (dispose) {
			forgetQueueConsultRelease(id);
			continue;
		}
		try {
			release.guard();
		} catch {
			forgetQueueConsultRelease(id);
		}
	}
}
