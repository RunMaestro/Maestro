import { buildConsultPendingNote, buildHandoffPendingNote } from '../../shared/crossAgentContext';
import { getPrompt } from '../prompt-manager';
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
	snapshot: QueueRoutingSnapshot,
	allocateSteps = true
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
		requestId: allocateSteps ? randomUUID() : '',
		status: 'prepared',
	}));
	if (routing !== 'only')
		steps.push({
			kind: 'local',
			targetAgentId: sourceAgentId,
			requestId: allocateSteps ? randomUUID() : '',
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
	const current = prepareQueueRouting(item, sourceAgentId, snapshot, false);
	if (
		!current ||
		canonicalJson({ routing: current.routing, targets: current.targets }) !==
			canonicalJson({ routing: pinned.routing, targets: pinned.targets })
	) {
		throw new Error('DispatchRoutingRecipientChanged');
	}
}

/** Immediate notes or a live host-derived consult-first continuation; wire context grants nothing. */
export function queueLocalPrompt(
	item: PianolaQueueItem,
	sourceAgentId: string,
	snapshot: QueueRoutingSnapshot
): string {
	if ('agentContext' in item && item.agentContext)
		throw new Error('DispatchQueueRoutingUnsupported');
	const plan = prepareQueueRouting(item, sourceAgentId, snapshot, false);
	if (
		plan?.routing === 'consult-first' ||
		(plan?.routing === 'parallel' && routingReleases.get(item.id)?.replyReady?.())
	) {
		const release = routingReleases.get(item.id);
		if (
			!release?.localPrompt ||
			release.sourceAgentId !== sourceAgentId ||
			release.sourceTabId !== item.tabId
		)
			throw new Error('DispatchRoutingReleaseUnavailable');
		return release.localPrompt();
	}
	if (!plan || !['parallel', 'handoff'].includes(plan.routing))
		throw new Error('DispatchQueueLocalUnavailable');
	const names = plan.targets.map((t) => snapshot.agents.find((a) => a.id === t.agentId)!.name);
	const note =
		plan.routing === 'parallel'
			? buildConsultPendingNote(getPrompt('cross-agent-consult-pending'), names)
			: buildHandoffPendingNote(getPrompt('cross-agent-handoff-pending'), names);
	return `${item.text}\n\n---\n\n${note}`;
}

/** Native release closures only. This map is intentionally process-local: reading
 * an old admission after a restart cannot reconstruct permission to send. */
const routingReleases = new Map<
	string,
	{
		sourceAgentId: string;
		sourceTabId: string;
		generation: string;
		guard(): void;
		localPrompt?(): string;
		replyReady?(): boolean;
		revoke(): void;
		start?(
			targetAgentId: string,
			opts: Omit<
				import('../cross-agent/cross-agent-router').StartCrossAgentRequestOptions,
				'nativeAdmission'
			>
		): Promise<{ requestId: string }>;
	}
>();

export function bindQueueRoutingRelease(
	dispatchId: string,
	release: NonNullable<ReturnType<typeof routingReleases.get>>
): void {
	sweepQueueConsultReleases();
	release.guard();
	forgetQueueConsultRelease(dispatchId);
	// Fail closed under pressure: eviction removes only future send authority,
	// never the ConsultService's supervision of already claimed children.
	while (routingReleases.size >= 256)
		forgetQueueConsultRelease(routingReleases.keys().next().value!);
	routingReleases.set(dispatchId, release);
}

/** Consult transport is installed only for routing modes with consult steps. */
export function bindQueueConsultRelease(
	dispatchId: string,
	release: NonNullable<ReturnType<typeof routingReleases.get>> & {
		localPrompt(): string;
		start: NonNullable<NonNullable<ReturnType<typeof routingReleases.get>>['start']>;
	}
): void {
	bindQueueRoutingRelease(dispatchId, release);
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
	const release = routingReleases.get(locator.dispatchId);
	if (
		!release?.start ||
		release.sourceAgentId !== sourceAgentId ||
		release.sourceTabId !== sourceTabId ||
		release.generation !== locator.generation
	)
		return Promise.reject(new Error('DispatchRoutingReleaseUnavailable'));
	return release.start(targetAgentId, opts);
}

export function forgetQueueConsultRelease(dispatchId: string): boolean {
	const release = routingReleases.get(dispatchId);
	routingReleases.delete(dispatchId);
	release?.revoke();
	return !!release;
}

/** Called by existing supervisor health/reconcile/stop boundaries; no new timer.
 * Expired, cancelled or invalid policy releases cannot retain service closures. */
// Lifecycle entries cover all modes; only consult modes carry a start capability.
export let queueRoutingEpoch = 0;

export function sweepQueueConsultReleases(dispose = false): void {
	if (dispose) queueRoutingEpoch++;
	for (const [id, release] of routingReleases) {
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
