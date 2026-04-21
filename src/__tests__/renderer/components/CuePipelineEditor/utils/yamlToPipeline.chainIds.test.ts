/**
 * Regression tests for chain-source resolution by stable ID.
 *
 * The "two agents swapped" bug happened because chain subscriptions
 * referenced upstream agents by session NAME (`source_session`). When the
 * upstream agent was renamed, the name in YAML no longer matched any
 * session and the name-based heuristic would resolve to the wrong agent
 * (or silently drop the edge).
 *
 * Commit 4 adds `source_session_ids` as a dual-written, ID-based reference
 * that's preferred on load. These tests lock in the new behaviour.
 *
 * Note: pipeline grouping strips the `-chain-\d+` suffix from subscription
 * names (see `getBasePipelineName`). Trigger subs share the pipeline base
 * name; chain subs use `<base>-chain-N`.
 */

import { describe, it, expect } from 'vitest';

import { subscriptionsToPipelines } from '../../../../../renderer/components/CuePipelineEditor/utils/yamlToPipeline';
import type { CueSubscription } from '../../../../../shared/cue/contracts';

function makeSessions(entries: Array<[string, string]>) {
	return entries.map(([id, name]) => ({ id, name, toolType: 'claude-code' as const }));
}

describe('chain source resolution by stable agent_id', () => {
	it('resolves chain source via source_session_ids when the upstream agent has been renamed', () => {
		const subs: CueSubscription[] = [
			{
				name: 'pipe',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'upstream prompt',
				interval_minutes: 5,
				agent_id: 'sess-up',
			},
			{
				name: 'pipe-chain-1',
				event: 'agent.completed',
				enabled: true,
				prompt: 'downstream prompt',
				source_session: ['Original'],
				source_session_ids: ['sess-up'],
				agent_id: 'sess-down',
			},
		];
		const sessions = makeSessions([
			['sess-up', 'Renamed'],
			['sess-down', 'Downstream'],
		]);

		const [pipeline] = subscriptionsToPipelines(subs, sessions);
		const agentNodes = pipeline.nodes.filter((n) => n.type === 'agent');
		const names = agentNodes.map((n) => (n.data as { sessionName: string }).sessionName);

		expect(names).toContain('Renamed');
		expect(names).toContain('Downstream');
		expect(names).not.toContain('Original');
	});

	it('round-trips fan-in with source_session_ids array', () => {
		const subs: CueSubscription[] = [
			{
				name: 'fanin',
				event: 'time.heartbeat',
				enabled: true,
				prompt: '',
				interval_minutes: 5,
				agent_id: 'sess-a',
				fan_out: ['A', 'B'],
			},
			{
				name: 'fanin-chain-1',
				event: 'agent.completed',
				enabled: true,
				prompt: '',
				source_session: ['A', 'B'],
				source_session_ids: ['sess-a', 'sess-b'],
				agent_id: 'sess-target',
			},
		];
		const sessions = makeSessions([
			['sess-a', 'A'],
			['sess-b', 'B'],
			['sess-target', 'Target'],
		]);

		const [pipeline] = subscriptionsToPipelines(subs, sessions);
		const agentNames = pipeline.nodes
			.filter((n) => n.type === 'agent')
			.map((n) => (n.data as { sessionName: string }).sessionName);
		expect(agentNames).toEqual(expect.arrayContaining(['A', 'B', 'Target']));

		const targetNode = pipeline.nodes.find(
			(n) => n.type === 'agent' && (n.data as { sessionName: string }).sessionName === 'Target'
		)!;
		const incoming = pipeline.edges.filter((e) => e.target === targetNode.id);
		expect(incoming).toHaveLength(2);
	});

	it('falls back to legacy source_session names when source_session_ids is absent', () => {
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
			['sess-down', 'Downstream'],
		]);

		const [pipeline] = subscriptionsToPipelines(subs, sessions);
		const agentNames = pipeline.nodes
			.filter((n) => n.type === 'agent')
			.map((n) => (n.data as { sessionName: string }).sessionName);
		expect(agentNames).toEqual(expect.arrayContaining(['Upstream', 'Downstream']));
	});

	it('surfaces an error node (NOT a silent name-fallback) when source_session_ids references a deleted session', () => {
		// Regression guard for the "silent identity swap": if the user deleted an
		// agent and recreated a DIFFERENT agent that happens to share the same
		// visible name, resolving via the name would silently rewire the chain
		// to the new agent — hiding the fact that the original reference is
		// gone. Once an ID is present and fails to resolve, we stop and emit an
		// error node. The user can then Reassign or Remove explicitly.
		const subs: CueSubscription[] = [
			{
				name: 'orphan',
				event: 'time.heartbeat',
				enabled: true,
				prompt: '',
				interval_minutes: 5,
				agent_id: 'sess-current',
			},
			{
				name: 'orphan-chain-1',
				event: 'agent.completed',
				enabled: true,
				prompt: '',
				source_session: ['StillPresent'],
				source_session_ids: ['sess-deleted-uuid'],
				agent_id: 'sess-down',
			},
		];
		const sessions = makeSessions([
			['sess-current', 'Current'],
			['sess-present', 'StillPresent'],
			['sess-down', 'Downstream'],
		]);

		const [pipeline] = subscriptionsToPipelines(subs, sessions);
		const agentNames = pipeline.nodes
			.filter((n) => n.type === 'agent')
			.map((n) => (n.data as { sessionName: string }).sessionName);
		// The live-session agent that happens to share the legacy name must
		// NOT be wired into this pipeline — its identity is different from the
		// deleted reference. It may still appear as a node because it owns its
		// own trigger sub, but it must not be the resolved source of the
		// chain edge.
		const errorNodes = pipeline.nodes.filter((n) => n.type === 'error');
		expect(errorNodes.length).toBeGreaterThanOrEqual(1);
		const sourceError = errorNodes.find(
			(n) => (n.data as { reason: string }).reason === 'missing-source'
		);
		expect(sourceError).toBeDefined();
		expect((sourceError!.data as { unresolvedId?: string }).unresolvedId).toBe('sess-deleted-uuid');
		// Downstream agent still wired; Current still present (owns trigger sub);
		// no silent adoption of the StillPresent agent as the chain source.
		expect(agentNames).toContain('Downstream');

		// Topology guard: checking node presence alone isn't enough — a buggy
		// resolver could still render the error node AND wire the Downstream
		// chain edge to the live StillPresent agent. Walk the downstream
		// agent's incoming edges and verify none of them originates from the
		// live-sessionName agent; the only valid source for the chain-1 sub
		// is the error node.
		const downstreamNode = pipeline.nodes.find(
			(n) => n.type === 'agent' && (n.data as { sessionName: string }).sessionName === 'Downstream'
		);
		expect(downstreamNode).toBeDefined();
		const stillPresentNode = pipeline.nodes.find(
			(n) =>
				n.type === 'agent' && (n.data as { sessionName: string }).sessionName === 'StillPresent'
		);
		const incomingToDownstream = pipeline.edges.filter((e) => e.target === downstreamNode!.id);
		expect(incomingToDownstream.length).toBeGreaterThan(0);
		for (const edge of incomingToDownstream) {
			// Must NOT be adopted from the StillPresent live agent.
			if (stillPresentNode) {
				expect(edge.source).not.toBe(stillPresentNode.id);
			}
			// AND the only valid source is the emitted error node.
			expect(edge.source).toBe(sourceError!.id);
		}
	});

	it('ID wins over name when both resolve to different sessions', () => {
		const subs: CueSubscription[] = [
			{
				name: 'ambiguous',
				event: 'time.heartbeat',
				enabled: true,
				prompt: '',
				interval_minutes: 5,
				agent_id: 'sess-original',
			},
			{
				name: 'ambiguous-chain-1',
				event: 'agent.completed',
				enabled: true,
				prompt: '',
				source_session: ['Alpha'],
				source_session_ids: ['sess-original'],
				agent_id: 'sess-down',
			},
		];
		const sessions = makeSessions([
			['sess-original', 'Beta'],
			['sess-new-alpha', 'Alpha'],
			['sess-down', 'Downstream'],
		]);

		const [pipeline] = subscriptionsToPipelines(subs, sessions);
		const agentNames = pipeline.nodes
			.filter((n) => n.type === 'agent')
			.map((n) => (n.data as { sessionName: string }).sessionName);
		expect(agentNames).toContain('Beta');
		expect(agentNames).not.toContain('Alpha');
	});
});
