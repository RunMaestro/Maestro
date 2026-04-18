/**
 * Regression tests for unresolved-agent error nodes.
 *
 * When YAML references a session that no longer exists, the loader used to
 * fall through to a name-based heuristic and could silently pick the wrong
 * agent (the "two agents swapped" bug). Commit 5 emits a visible "error"
 * type PipelineNode in that situation so the user can see and resolve it.
 */

import { describe, it, expect } from 'vitest';

import { subscriptionsToPipelines } from '../../../../../renderer/components/CuePipelineEditor/utils/yamlToPipeline';
import type { ErrorNodeData, PipelineNode } from '../../../../../shared/cue-pipeline-types';
import type { CueSubscription } from '../../../../../shared/cue/contracts';

function makeSessions(entries: Array<[string, string]>) {
	return entries.map(([id, name]) => ({ id, name, toolType: 'claude-code' as const }));
}

function errorNodes(nodes: PipelineNode[]): PipelineNode[] {
	return nodes.filter((n) => n.type === 'error');
}

describe('yamlToPipeline — error nodes for unresolved agents', () => {
	it('emits a missing-target error node when agent_id references a deleted session (initial trigger)', () => {
		const subs: CueSubscription[] = [
			{
				name: 'orphan',
				event: 'time.heartbeat',
				enabled: true,
				prompt: '',
				interval_minutes: 5,
				agent_id: 'deleted-uuid',
			},
		];
		const sessions = makeSessions([['other-uuid', 'Other']]);

		const [pipeline] = subscriptionsToPipelines(subs, sessions);
		const errs = errorNodes(pipeline.nodes);
		expect(errs).toHaveLength(1);
		const data = errs[0].data as ErrorNodeData;
		expect(data.reason).toBe('missing-target');
		expect(data.unresolvedId).toBe('deleted-uuid');
		expect(data.subscriptionName).toBe('orphan');
	});

	it('emits a missing-target error node when a chain subscription references a deleted target', () => {
		const subs: CueSubscription[] = [
			{
				name: 'pipe',
				event: 'time.heartbeat',
				enabled: true,
				prompt: '',
				interval_minutes: 5,
				agent_id: 'sess-up',
			},
			{
				name: 'pipe-chain-1',
				event: 'agent.completed',
				enabled: true,
				prompt: '',
				source_session: ['Up'],
				source_session_ids: ['sess-up'],
				agent_id: 'deleted-downstream',
			},
		];
		const sessions = makeSessions([['sess-up', 'Up']]);

		const [pipeline] = subscriptionsToPipelines(subs, sessions);
		const errs = errorNodes(pipeline.nodes);
		expect(errs).toHaveLength(1);
		expect((errs[0].data as ErrorNodeData).reason).toBe('missing-target');
		expect((errs[0].data as ErrorNodeData).unresolvedId).toBe('deleted-downstream');
	});

	it('emits a missing-source error node when source_session_ids references a deleted upstream (no name fallback)', () => {
		const subs: CueSubscription[] = [
			{
				name: 'pipe',
				event: 'time.heartbeat',
				enabled: true,
				prompt: '',
				interval_minutes: 5,
				agent_id: 'sess-down',
			},
			{
				name: 'pipe-chain-1',
				event: 'agent.completed',
				enabled: true,
				prompt: '',
				source_session: ['GhostUpstream'],
				source_session_ids: ['deleted-upstream-uuid'],
				agent_id: 'sess-down',
			},
		];
		// Neither the ID nor the name resolves.
		const sessions = makeSessions([['sess-down', 'Down']]);

		const [pipeline] = subscriptionsToPipelines(subs, sessions);
		const errs = errorNodes(pipeline.nodes);
		expect(errs.length).toBeGreaterThanOrEqual(1);
		const sourceErr = errs.find((e) => (e.data as ErrorNodeData).reason === 'missing-source');
		expect(sourceErr).toBeDefined();
		expect((sourceErr!.data as ErrorNodeData).unresolvedId).toBe('deleted-upstream-uuid');
		expect((sourceErr!.data as ErrorNodeData).unresolvedName).toBe('GhostUpstream');
	});

	it('emits an error node (no silent swap) even when the upstream name matches a DIFFERENT live session', () => {
		// Regression guard for silent identity swap: a user deleted the
		// original upstream (uuid "deleted-upstream-uuid") and recreated a
		// new agent that happens to share the same visible name "Upstream"
		// but has a different uuid. Resolving via name would silently wire
		// the chain to the new agent, hiding the fact that the original
		// reference is gone. The loader MUST surface this as an error node.
		const subs: CueSubscription[] = [
			{
				name: 'pipe',
				event: 'time.heartbeat',
				enabled: true,
				prompt: '',
				interval_minutes: 5,
				agent_id: 'sess-up',
			},
			{
				name: 'pipe-chain-1',
				event: 'agent.completed',
				enabled: true,
				prompt: '',
				source_session: ['Upstream'],
				source_session_ids: ['deleted-upstream-uuid'],
				agent_id: 'sess-down',
			},
		];
		// ID misses but name matches a live session (different uuid — a
		// recreated agent that reused the name). We must NOT silently adopt
		// it as the resolved source.
		const sessions = makeSessions([
			['sess-live-upstream', 'Upstream'],
			['sess-up', 'Anchor'],
			['sess-down', 'Down'],
		]);

		const [pipeline] = subscriptionsToPipelines(subs, sessions);
		const errs = errorNodes(pipeline.nodes);
		expect(errs.length).toBeGreaterThanOrEqual(1);
		const sourceErr = errs.find((e) => (e.data as ErrorNodeData).reason === 'missing-source');
		expect(sourceErr).toBeDefined();
		expect((sourceErr!.data as ErrorNodeData).unresolvedId).toBe('deleted-upstream-uuid');
		// Name is still carried so the user can see what the original
		// reference was called, without implying the live agent with the
		// same name is the correct replacement.
		expect((sourceErr!.data as ErrorNodeData).unresolvedName).toBe('Upstream');
	});

	it('does NOT emit an error node when legacy YAML has name but no ID', () => {
		// Pre-Commit-4 YAML: no source_session_ids, name-based resolution.
		const subs: CueSubscription[] = [
			{
				name: 'legacy',
				event: 'time.heartbeat',
				enabled: true,
				prompt: '',
				interval_minutes: 5,
				agent_id: 'sess-up',
			},
			{
				name: 'legacy-chain-1',
				event: 'agent.completed',
				enabled: true,
				prompt: '',
				source_session: ['Upstream'],
				agent_id: 'sess-down',
			},
		];
		const sessions = makeSessions([
			['sess-up', 'Upstream'],
			['sess-down', 'Down'],
		]);

		const [pipeline] = subscriptionsToPipelines(subs, sessions);
		expect(errorNodes(pipeline.nodes)).toHaveLength(0);
	});

	it('graph is isomorphic when subscriptions are reordered in YAML', () => {
		// The "two agents swapped" bug was reproducible by reloading the same
		// YAML with subscriptions in different orders. Sort is now deterministic
		// (initial triggers first, then chain-index, then name) so the graph
		// topology must be identical regardless of source ordering.
		const subs1: CueSubscription[] = [
			{
				name: 'pipe',
				event: 'time.heartbeat',
				enabled: true,
				prompt: '',
				interval_minutes: 5,
				agent_id: 'sess-a',
			},
			{
				name: 'pipe-chain-1',
				event: 'agent.completed',
				enabled: true,
				prompt: '',
				source_session: ['A'],
				source_session_ids: ['sess-a'],
				agent_id: 'sess-b',
			},
			{
				name: 'pipe-chain-2',
				event: 'agent.completed',
				enabled: true,
				prompt: '',
				source_session: ['B'],
				source_session_ids: ['sess-b'],
				agent_id: 'sess-c',
			},
		];
		// Reversed order — chain-2 first, then chain-1, then trigger.
		const subs2: CueSubscription[] = [subs1[2], subs1[1], subs1[0]];

		const sessions = makeSessions([
			['sess-a', 'A'],
			['sess-b', 'B'],
			['sess-c', 'C'],
		]);

		const [p1] = subscriptionsToPipelines(subs1, sessions);
		const [p2] = subscriptionsToPipelines(subs2, sessions);

		const labelFor = (node: PipelineNode) =>
			node.type === 'agent'
				? `agent:${(node.data as { sessionName: string }).sessionName}`
				: node.type;
		const summarize = (nodes: PipelineNode[]) => nodes.map(labelFor).sort();

		// Build normalized edge topology as "sourceLabel->targetLabel" strings
		// keyed by node id. Sorting makes the comparison order-independent,
		// so the test asserts graph ISOMORPHISM (same nodes connected the
		// same way), not just matching node/edge counts. This catches bugs
		// where a different YAML write order would produce the right set of
		// edges but wire them to the wrong agents.
		const summarizeEdges = (nodes: PipelineNode[], edges: { source: string; target: string }[]) => {
			const idToLabel = new Map<string, string>();
			for (const n of nodes) idToLabel.set(n.id, labelFor(n));
			return edges
				.map(
					(e) => `${idToLabel.get(e.source) ?? e.source}->${idToLabel.get(e.target) ?? e.target}`
				)
				.sort();
		};

		expect(summarize(p1.nodes)).toEqual(summarize(p2.nodes));
		expect(summarizeEdges(p1.nodes, p1.edges)).toEqual(summarizeEdges(p2.nodes, p2.edges));
	});
});
