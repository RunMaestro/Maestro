/**
 * Tests for yamlToPipeline conversion utilities.
 *
 * Verifies that CueSubscription objects and CueGraphSession data
 * correctly convert back into visual CuePipeline structures.
 */

import { describe, it, expect } from 'vitest';
import {
	subscriptionsToPipelines,
	graphSessionsToPipelines,
} from '../../../../../renderer/components/CuePipelineEditor/utils/yamlToPipeline';
import type { CueSubscription, CueGraphSession } from '../../../../../main/cue/cue-types';
import type { SessionInfo } from '../../../../../shared/types';
import type {
	AgentNodeData,
	CommandNodeData,
	PipelineNode,
} from '../../../../../shared/cue-pipeline-types';

const makeSessions = (...names: string[]): SessionInfo[] =>
	names.map((name, i) => ({
		id: `session-${i}`,
		name,
		toolType: 'claude-code' as const,
		cwd: '/tmp',
		projectRoot: '/tmp',
	}));

describe('subscriptionsToPipelines', () => {
	it('returns empty array for no subscriptions', () => {
		const result = subscriptionsToPipelines([], []);
		expect(result).toEqual([]);
	});

	it('converts a simple trigger -> agent subscription', () => {
		const subs: CueSubscription[] = [
			{
				name: 'my-pipeline',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'Do the work',
				interval_minutes: 10,
			},
		];
		const sessions = makeSessions('worker');

		const pipelines = subscriptionsToPipelines(subs, sessions);
		expect(pipelines).toHaveLength(1);
		expect(pipelines[0].name).toBe('my-pipeline');

		// Should have a trigger node and an agent node
		const triggers = pipelines[0].nodes.filter((n) => n.type === 'trigger');
		const agents = pipelines[0].nodes.filter((n) => n.type === 'agent');
		expect(triggers).toHaveLength(1);
		expect(agents).toHaveLength(1);

		// Trigger should have correct event type and config
		expect(triggers[0].data).toMatchObject({
			eventType: 'time.heartbeat',
			config: { interval_minutes: 10 },
		});

		// Agent should have the input prompt
		expect(agents[0].data).toMatchObject({
			sessionName: 'worker',
			inputPrompt: 'Do the work',
		});

		// Should have one edge connecting them
		expect(pipelines[0].edges).toHaveLength(1);
		expect(pipelines[0].edges[0].source).toBe(triggers[0].id);
		expect(pipelines[0].edges[0].target).toBe(agents[0].id);
	});

	it('converts trigger -> agent1 -> agent2 chain', () => {
		const subs: CueSubscription[] = [
			{
				name: 'chain-test',
				event: 'file.changed',
				enabled: true,
				prompt: 'Build it',
				watch: 'src/**/*.ts',
			},
			{
				name: 'chain-test-chain-1',
				event: 'agent.completed',
				enabled: true,
				prompt: 'Test it',
				source_session: 'builder',
			},
		];
		const sessions = makeSessions('builder', 'tester');

		const pipelines = subscriptionsToPipelines(subs, sessions);
		expect(pipelines).toHaveLength(1);

		const triggers = pipelines[0].nodes.filter((n) => n.type === 'trigger');
		const agents = pipelines[0].nodes.filter((n) => n.type === 'agent');
		expect(triggers).toHaveLength(1);
		expect(agents).toHaveLength(2);

		// Trigger config
		expect(triggers[0].data).toMatchObject({
			eventType: 'file.changed',
			config: { watch: 'src/**/*.ts' },
		});

		// Should have edges: trigger -> builder, builder -> tester
		expect(pipelines[0].edges).toHaveLength(2);
	});

	it('handles fan-out (trigger -> [agent1, agent2])', () => {
		const subs: CueSubscription[] = [
			{
				name: 'fanout-test',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'Task A',
				interval_minutes: 30,
				fan_out: ['worker-a', 'worker-b'],
			},
		];
		const sessions = makeSessions('worker-a', 'worker-b');

		const pipelines = subscriptionsToPipelines(subs, sessions);
		expect(pipelines).toHaveLength(1);

		const triggers = pipelines[0].nodes.filter((n) => n.type === 'trigger');
		const agents = pipelines[0].nodes.filter((n) => n.type === 'agent');
		expect(triggers).toHaveLength(1);
		expect(agents).toHaveLength(2);

		// Both agents should be connected to the trigger
		expect(pipelines[0].edges).toHaveLength(2);
		for (const edge of pipelines[0].edges) {
			expect(edge.source).toBe(triggers[0].id);
		}

		const agentNames = agents.map((a) => (a.data as { sessionName: string }).sessionName);
		expect(agentNames).toContain('worker-a');
		expect(agentNames).toContain('worker-b');
	});

	it('handles fan-in ([agent1, agent2] -> agent3)', () => {
		const subs: CueSubscription[] = [
			{
				name: 'fanin-test',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'Start',
				interval_minutes: 5,
				fan_out: ['worker-a', 'worker-b'],
			},
			{
				name: 'fanin-test-chain-1',
				event: 'agent.completed',
				enabled: true,
				prompt: 'Combine results',
				source_session: ['worker-a', 'worker-b'],
			},
		];
		const sessions = makeSessions('worker-a', 'worker-b', 'aggregator');

		const pipelines = subscriptionsToPipelines(subs, sessions);
		expect(pipelines).toHaveLength(1);

		const agents = pipelines[0].nodes.filter((n) => n.type === 'agent');
		// worker-a, worker-b, and the aggregator target
		expect(agents.length).toBeGreaterThanOrEqual(3);

		// The aggregator should have 2 incoming edges (from worker-a and worker-b)
		const aggregatorNode = agents.find(
			(a) => (a.data as { sessionName: string }).sessionName === 'aggregator'
		);
		expect(aggregatorNode).toBeDefined();

		const incomingEdges = pipelines[0].edges.filter((e) => e.target === aggregatorNode!.id);
		expect(incomingEdges).toHaveLength(2);
	});

	it('maps github.pull_request trigger config', () => {
		const subs: CueSubscription[] = [
			{
				name: 'pr-review',
				event: 'github.pull_request',
				enabled: true,
				prompt: 'Review this PR',
				repo: 'owner/repo',
				poll_minutes: 5,
			},
		];
		const sessions = makeSessions('reviewer');

		const pipelines = subscriptionsToPipelines(subs, sessions);
		const trigger = pipelines[0].nodes.find((n) => n.type === 'trigger');
		expect(trigger).toBeDefined();
		expect(trigger!.data).toMatchObject({
			eventType: 'github.pull_request',
			config: { repo: 'owner/repo', poll_minutes: 5 },
		});
	});

	it('maps task.pending trigger config', () => {
		const subs: CueSubscription[] = [
			{
				name: 'task-handler',
				event: 'task.pending',
				enabled: true,
				prompt: 'Complete tasks',
				watch: 'docs/**/*.md',
			},
		];
		const sessions = makeSessions('tasker');

		const pipelines = subscriptionsToPipelines(subs, sessions);
		const trigger = pipelines[0].nodes.find((n) => n.type === 'trigger');
		expect(trigger!.data).toMatchObject({
			eventType: 'task.pending',
			config: { watch: 'docs/**/*.md' },
		});
	});

	it('groups subscriptions into separate pipelines by name prefix', () => {
		const subs: CueSubscription[] = [
			{
				name: 'pipeline-a',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'Task A',
				interval_minutes: 5,
			},
			{
				name: 'pipeline-b',
				event: 'file.changed',
				enabled: true,
				prompt: 'Task B',
				watch: '**/*.ts',
			},
		];
		const sessions = makeSessions('worker-a', 'worker-b');

		const pipelines = subscriptionsToPipelines(subs, sessions);
		expect(pipelines).toHaveLength(2);
		expect(pipelines[0].name).toBe('pipeline-a');
		expect(pipelines[1].name).toBe('pipeline-b');
	});

	it('assigns unique colors to each pipeline', () => {
		const subs: CueSubscription[] = [
			{
				name: 'p1',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'A',
				interval_minutes: 5,
			},
			{
				name: 'p2',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'B',
				interval_minutes: 10,
			},
		];
		const sessions = makeSessions('worker');

		const pipelines = subscriptionsToPipelines(subs, sessions);
		expect(pipelines[0].color).not.toBe(pipelines[1].color);
	});

	it('auto-layouts nodes left-to-right', () => {
		const subs: CueSubscription[] = [
			{
				name: 'layout-test',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'Build',
				interval_minutes: 5,
			},
			{
				name: 'layout-test-chain-1',
				event: 'agent.completed',
				enabled: true,
				prompt: 'Test',
				source_session: 'builder',
			},
		];
		const sessions = makeSessions('builder', 'tester');

		const pipelines = subscriptionsToPipelines(subs, sessions);
		const triggers = pipelines[0].nodes.filter((n) => n.type === 'trigger');
		const agents = pipelines[0].nodes.filter((n) => n.type === 'agent');

		// Trigger should be leftmost
		expect(triggers[0].position.x).toBe(100);
		// First agent should be further right
		expect(agents[0].position.x).toBeGreaterThan(triggers[0].position.x);
		// Second agent should be even further right (if present)
		if (agents.length > 1) {
			expect(agents[1].position.x).toBeGreaterThan(agents[0].position.x);
		}
	});

	it('deduplicates agent nodes by session name', () => {
		const subs: CueSubscription[] = [
			{
				name: 'dedup-test',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'Start',
				interval_minutes: 5,
				fan_out: ['worker-a', 'worker-b'],
			},
			{
				name: 'dedup-test-chain-1',
				event: 'agent.completed',
				enabled: true,
				prompt: 'Combine',
				source_session: ['worker-a', 'worker-b'],
			},
		];
		const sessions = makeSessions('worker-a', 'worker-b', 'combiner');

		const pipelines = subscriptionsToPipelines(subs, sessions);
		const agents = pipelines[0].nodes.filter((n) => n.type === 'agent');
		const sessionNames = agents.map((a) => (a.data as { sessionName: string }).sessionName);

		// worker-a and worker-b should appear only once each
		const workerACount = sessionNames.filter((n) => n === 'worker-a').length;
		const workerBCount = sessionNames.filter((n) => n === 'worker-b').length;
		expect(workerACount).toBe(1);
		expect(workerBCount).toBe(1);
	});

	it('resolves target session from agent_id', () => {
		const subs: CueSubscription[] = [
			{
				name: 'agent-id-test',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'Do work',
				interval_minutes: 10,
				agent_id: 'session-1',
			},
		];
		// session-1 maps to 'specific-worker', session-0 maps to 'other-agent'
		const sessions = makeSessions('other-agent', 'specific-worker');

		const pipelines = subscriptionsToPipelines(subs, sessions);
		expect(pipelines).toHaveLength(1);

		const agents = pipelines[0].nodes.filter((n) => n.type === 'agent');
		expect(agents).toHaveLength(1);
		expect((agents[0].data as { sessionName: string }).sessionName).toBe('specific-worker');
		expect((agents[0].data as { sessionId: string }).sessionId).toBe('session-1');
	});

	it('resolves agent_id in chain subscriptions', () => {
		const subs: CueSubscription[] = [
			{
				name: 'chain-id',
				event: 'file.changed',
				enabled: true,
				prompt: 'Build',
				watch: 'src/**/*',
				agent_id: 'session-0',
			},
			{
				name: 'chain-id-chain-1',
				event: 'agent.completed',
				enabled: true,
				prompt: 'Test',
				source_session: 'builder',
				agent_id: 'session-1',
			},
		];
		const sessions = makeSessions('builder', 'tester');

		const pipelines = subscriptionsToPipelines(subs, sessions);
		expect(pipelines).toHaveLength(1);

		const agents = pipelines[0].nodes.filter((n) => n.type === 'agent');
		const agentNames = agents.map((a) => (a.data as { sessionName: string }).sessionName);
		expect(agentNames).toContain('builder');
		expect(agentNames).toContain('tester');
	});

	it('trusts explicit agent_id even when subscription name matches a different session', () => {
		// Per-project-root YAML partitioning guarantees agent_id is the source
		// of truth. A coincidental pipeline-name/session-name overlap must NOT
		// flip the resolved agent — doing so caused the "Maestro swap reverts"
		// bug where replacing an agent would snap back on reload.
		const subs: CueSubscription[] = [
			{
				name: 'Pedsidian',
				event: 'time.scheduled',
				enabled: true,
				prompt: 'Do briefing',
				schedule_times: ['08:30'],
				schedule_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
				agent_id: 'maestro-uuid',
			},
		];
		const sessions: SessionInfo[] = [
			{
				id: 'maestro-uuid',
				name: 'Maestro',
				toolType: 'claude-code',
				cwd: '/tmp',
				projectRoot: '/tmp',
			},
			{
				id: 'pedsidian-uuid',
				name: 'Pedsidian',
				toolType: 'claude-code',
				cwd: '/tmp',
				projectRoot: '/tmp',
			},
		];

		const pipelines = subscriptionsToPipelines(subs, sessions);
		expect(pipelines).toHaveLength(1);

		const agents = pipelines[0].nodes.filter((n) => n.type === 'agent');
		expect(agents).toHaveLength(1);
		// agent_id wins — resolves to Maestro despite the name match on Pedsidian.
		expect((agents[0].data as { sessionName: string }).sessionName).toBe('Maestro');
		expect((agents[0].data as { sessionId: string }).sessionId).toBe('maestro-uuid');
	});

	it('uses subscription name to find target when agent_id is absent', () => {
		// Pre-agent_id YAML: subscription named after the target session
		const subs: CueSubscription[] = [
			{
				name: 'Pedsidian',
				event: 'time.scheduled',
				enabled: true,
				prompt: 'Morning briefing',
				schedule_times: ['08:30'],
			},
		];
		const sessions = [
			{
				id: 'maestro-uuid',
				name: 'Maestro',
				toolType: 'claude-code',
				cwd: '/tmp',
				projectRoot: '/tmp',
			},
			{
				id: 'pedsidian-uuid',
				name: 'Pedsidian',
				toolType: 'claude-code',
				cwd: '/tmp',
				projectRoot: '/tmp',
			},
		] as SessionInfo[];

		const pipelines = subscriptionsToPipelines(subs, sessions);
		const agents = pipelines[0].nodes.filter((n) => n.type === 'agent');
		expect(agents).toHaveLength(1);
		// Should pick Pedsidian by name, not fall back to sessions[0] (Maestro)
		expect((agents[0].data as { sessionName: string }).sessionName).toBe('Pedsidian');
	});

	it('creates separate nodes when the same agent appears twice in a chain (A → B → A)', () => {
		const subs: CueSubscription[] = [
			{
				name: 'loop-test',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'Start',
				interval_minutes: 10,
				agent_id: 'session-0',
			},
			{
				name: 'loop-test-chain-1',
				event: 'agent.completed',
				enabled: true,
				prompt: 'Middle step',
				source_session: 'alpha',
				agent_id: 'session-1',
			},
			{
				name: 'loop-test-chain-2',
				event: 'agent.completed',
				enabled: true,
				prompt: 'Final step',
				source_session: 'beta',
				agent_id: 'session-0',
			},
		];
		const sessions = makeSessions('alpha', 'beta');

		const pipelines = subscriptionsToPipelines(subs, sessions);
		expect(pipelines).toHaveLength(1);

		const agents = pipelines[0].nodes.filter((n) => n.type === 'agent');
		const alphaNodes = agents.filter(
			(a) => (a.data as { sessionName: string }).sessionName === 'alpha'
		);

		// Should have TWO distinct nodes for "alpha", not one
		expect(alphaNodes).toHaveLength(2);
		expect(alphaNodes[0].id).not.toBe(alphaNodes[1].id);

		// Should have 3 edges: trigger→alpha, alpha→beta, beta→alpha(2nd)
		expect(pipelines[0].edges).toHaveLength(3);

		// The last edge should connect beta → alpha(2nd), not create a self-edge
		const lastEdge = pipelines[0].edges[2];
		const betaNode = agents.find(
			(a) => (a.data as { sessionName: string }).sessionName === 'beta'
		)!;
		expect(lastEdge.source).toBe(betaNode.id);
		expect(lastEdge.target).toBe(alphaNodes[1].id);
		expect(lastEdge.source).not.toBe(lastEdge.target);
	});

	it('connects edges correctly when same agent is consecutive (A → B → B)', () => {
		const subs: CueSubscription[] = [
			{
				name: 'consec-test',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'Start',
				interval_minutes: 10,
				agent_id: 'session-0',
			},
			{
				name: 'consec-test-chain-1',
				event: 'agent.completed',
				enabled: true,
				prompt: 'First pass',
				source_session: 'opencode',
				agent_id: 'session-1',
			},
			{
				name: 'consec-test-chain-2',
				event: 'agent.completed',
				enabled: true,
				prompt: 'Second pass',
				source_session: 'claude',
				agent_id: 'session-1',
			},
		];
		const sessions = makeSessions('opencode', 'claude');

		const pipelines = subscriptionsToPipelines(subs, sessions);
		expect(pipelines).toHaveLength(1);

		const agents = pipelines[0].nodes.filter((n) => n.type === 'agent');
		const claudeNodes = agents.filter(
			(a) => (a.data as { sessionName: string }).sessionName === 'claude'
		);

		// Two distinct nodes for "claude"
		expect(claudeNodes).toHaveLength(2);

		// 3 edges: trigger→opencode, opencode→claude(1), claude(1)→claude(2)
		expect(pipelines[0].edges).toHaveLength(3);

		// Edge from first claude → second claude (not a self-edge)
		const lastEdge = pipelines[0].edges[2];
		expect(lastEdge.source).toBe(claudeNodes[0].id);
		expect(lastEdge.target).toBe(claudeNodes[1].id);
		expect(lastEdge.source).not.toBe(lastEdge.target);
	});

	it('sets default edge mode to pass', () => {
		const subs: CueSubscription[] = [
			{
				name: 'mode-test',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'Go',
				interval_minutes: 5,
			},
		];
		const sessions = makeSessions('worker');

		const pipelines = subscriptionsToPipelines(subs, sessions);
		for (const edge of pipelines[0].edges) {
			expect(edge.mode).toBe('pass');
		}
	});
});

describe('graphSessionsToPipelines', () => {
	it('extracts subscriptions from graph sessions and converts', () => {
		const graphSessions: CueGraphSession[] = [
			{
				sessionId: 's1',
				sessionName: 'worker',
				toolType: 'claude-code',
				subscriptions: [
					{
						name: 'graph-test',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'Do work',
						interval_minutes: 15,
					},
				],
			},
		];
		const sessions = makeSessions('worker');

		const pipelines = graphSessionsToPipelines(graphSessions, sessions);
		expect(pipelines).toHaveLength(1);
		expect(pipelines[0].name).toBe('graph-test');

		const triggers = pipelines[0].nodes.filter((n) => n.type === 'trigger');
		expect(triggers).toHaveLength(1);
		expect(triggers[0].data).toMatchObject({
			eventType: 'time.heartbeat',
			config: { interval_minutes: 15 },
		});
	});

	it('combines subscriptions from multiple graph sessions', () => {
		const graphSessions: CueGraphSession[] = [
			{
				sessionId: 's1',
				sessionName: 'builder',
				toolType: 'claude-code',
				subscriptions: [
					{
						name: 'multi-test',
						event: 'file.changed',
						enabled: true,
						prompt: 'Build',
						watch: 'src/**/*',
					},
				],
			},
			{
				sessionId: 's2',
				sessionName: 'tester',
				toolType: 'claude-code',
				subscriptions: [
					{
						name: 'multi-test-chain-1',
						event: 'agent.completed',
						enabled: true,
						prompt: 'Test',
						source_session: 'builder',
					},
				],
			},
		];
		const sessions = makeSessions('builder', 'tester');

		const pipelines = graphSessionsToPipelines(graphSessions, sessions);
		expect(pipelines).toHaveLength(1);
		expect(pipelines[0].name).toBe('multi-test');
		expect(pipelines[0].edges.length).toBeGreaterThanOrEqual(2);
	});

	it('returns empty array for no graph sessions', () => {
		const result = graphSessionsToPipelines([], []);
		expect(result).toEqual([]);
	});

	it('uses owning graph session name for agent nodes (dashboard matching)', () => {
		// Simulates the dashboard scenario: a session "PedTome RSSidian" has a
		// cue.yaml with an issue trigger. The agent node should use that session's
		// name so getPipelineColorForAgent can match it by sessionId.
		const graphSessions: CueGraphSession[] = [
			{
				sessionId: 'real-uuid-123',
				sessionName: 'PedTome RSSidian',
				toolType: 'claude-code',
				subscriptions: [
					{
						name: 'issue-triage',
						event: 'github.issue',
						enabled: true,
						prompt: 'Triage this issue',
						repo: 'RunMaestro/Maestro',
					},
				],
			},
		];
		const sessions: SessionInfo[] = [
			{
				id: 'real-uuid-123',
				name: 'PedTome RSSidian',
				toolType: 'claude-code',
				cwd: '/tmp',
				projectRoot: '/tmp',
			},
			{
				id: 'other-uuid-456',
				name: 'Maestro',
				toolType: 'claude-code',
				cwd: '/tmp',
				projectRoot: '/tmp',
			},
		];

		const pipelines = graphSessionsToPipelines(graphSessions, sessions);
		expect(pipelines).toHaveLength(1);

		const agents = pipelines[0].nodes.filter((n) => n.type === 'agent');
		expect(agents).toHaveLength(1);
		expect((agents[0].data as { sessionName: string }).sessionName).toBe('PedTome RSSidian');
		expect((agents[0].data as { sessionId: string }).sessionId).toBe('real-uuid-123');
	});

	it('correctly maps agents when multiple sessions share subscriptions', () => {
		// Two sessions share the same project root / cue.yaml with a chain pipeline.
		// Both report all subscriptions. The builder should be target of the initial
		// trigger, and the tester should be target of the chain-1 sub.
		const sharedSubs = [
			{
				name: 'shared-pipeline',
				event: 'file.changed' as const,
				enabled: true,
				prompt: 'Build',
				watch: 'src/**/*',
			},
			{
				name: 'shared-pipeline-chain-1',
				event: 'agent.completed' as const,
				enabled: true,
				prompt: 'Test',
				source_session: 'builder',
			},
		];
		const graphSessions: CueGraphSession[] = [
			{
				sessionId: 'builder-id',
				sessionName: 'builder',
				toolType: 'claude-code',
				subscriptions: sharedSubs,
			},
			{
				sessionId: 'tester-id',
				sessionName: 'tester',
				toolType: 'claude-code',
				subscriptions: sharedSubs,
			},
		];
		const sessions = makeSessions('builder', 'tester');

		const pipelines = graphSessionsToPipelines(graphSessions, sessions);
		expect(pipelines).toHaveLength(1);

		const agents = pipelines[0].nodes.filter((n) => n.type === 'agent');
		const agentNames = agents.map((a) => (a.data as { sessionName: string }).sessionName);
		expect(agentNames).toContain('builder');
		expect(agentNames).toContain('tester');
	});
});

describe('auto-injected source output prefix stripping', () => {
	it('strips auto-injected {{CUE_SOURCE_OUTPUT}} prefix from chain prompt', () => {
		const subs: CueSubscription[] = [
			{
				name: 'pipe',
				event: 'file.changed',
				enabled: true,
				watch: '**/*',
				prompt: 'Build',
				agent_id: 's1',
			},
			{
				name: 'pipe-chain-1',
				event: 'agent.completed',
				enabled: true,
				source_session: 'builder',
				prompt: '{{CUE_SOURCE_OUTPUT}}\n\nTest it',
				agent_id: 's2',
			},
		];
		const sessions: SessionInfo[] = [
			{ id: 's1', name: 'builder', toolType: 'claude-code', workingDirectory: '' },
			{ id: 's2', name: 'tester', toolType: 'claude-code', workingDirectory: '' },
		];

		const pipelines = subscriptionsToPipelines(subs, sessions);
		const testerNode = pipelines[0].nodes.find(
			(n) => n.type === 'agent' && (n.data as { sessionName: string }).sessionName === 'tester'
		);
		expect(testerNode).toBeDefined();
		expect((testerNode!.data as { inputPrompt?: string }).inputPrompt).toBe('Test it');
	});

	it('preserves manually placed {{CUE_SOURCE_OUTPUT}} in middle of prompt', () => {
		const subs: CueSubscription[] = [
			{
				name: 'pipe',
				event: 'file.changed',
				enabled: true,
				watch: '**/*',
				prompt: 'Build',
				agent_id: 's1',
			},
			{
				name: 'pipe-chain-1',
				event: 'agent.completed',
				enabled: true,
				source_session: 'builder',
				prompt: 'Review this: {{CUE_SOURCE_OUTPUT}} and summarize',
				agent_id: 's2',
			},
		];
		const sessions: SessionInfo[] = [
			{ id: 's1', name: 'builder', toolType: 'claude-code', workingDirectory: '' },
			{ id: 's2', name: 'tester', toolType: 'claude-code', workingDirectory: '' },
		];

		const pipelines = subscriptionsToPipelines(subs, sessions);
		const testerNode = pipelines[0].nodes.find(
			(n) => n.type === 'agent' && (n.data as { sessionName: string }).sessionName === 'tester'
		);
		expect((testerNode!.data as { inputPrompt?: string }).inputPrompt).toBe(
			'Review this: {{CUE_SOURCE_OUTPUT}} and summarize'
		);
	});

	it('sets inputPrompt to undefined when prompt is only the auto-injected variable', () => {
		const subs: CueSubscription[] = [
			{
				name: 'pipe',
				event: 'file.changed',
				enabled: true,
				watch: '**/*',
				prompt: 'Build',
				agent_id: 's1',
			},
			{
				name: 'pipe-chain-1',
				event: 'agent.completed',
				enabled: true,
				source_session: 'builder',
				prompt: '{{CUE_SOURCE_OUTPUT}}\n\n',
				agent_id: 's2',
			},
		];
		const sessions: SessionInfo[] = [
			{ id: 's1', name: 'builder', toolType: 'claude-code', workingDirectory: '' },
			{ id: 's2', name: 'tester', toolType: 'claude-code', workingDirectory: '' },
		];

		const pipelines = subscriptionsToPipelines(subs, sessions);
		const testerNode = pipelines[0].nodes.find(
			(n) => n.type === 'agent' && (n.data as { sessionName: string }).sessionName === 'tester'
		);
		expect((testerNode!.data as { inputPrompt?: string }).inputPrompt).toBeUndefined();
	});

	it('strips bare {{CUE_SOURCE_OUTPUT}} token without trailing newlines', () => {
		const subs: CueSubscription[] = [
			{
				name: 'pipe',
				event: 'file.changed',
				enabled: true,
				watch: '**/*',
				prompt: 'Build',
				agent_id: 's1',
			},
			{
				name: 'pipe-chain-1',
				event: 'agent.completed',
				enabled: true,
				source_session: 'builder',
				prompt: '{{CUE_SOURCE_OUTPUT}}',
				agent_id: 's2',
			},
		];
		const sessions: SessionInfo[] = [
			{ id: 's1', name: 'builder', toolType: 'claude-code', workingDirectory: '' },
			{ id: 's2', name: 'tester', toolType: 'claude-code', workingDirectory: '' },
		];

		const pipelines = subscriptionsToPipelines(subs, sessions);
		const testerNode = pipelines[0].nodes.find(
			(n) => n.type === 'agent' && (n.data as { sessionName: string }).sessionName === 'tester'
		);
		expect((testerNode!.data as { inputPrompt?: string }).inputPrompt).toBeUndefined();
	});

	describe('command node deserialization', () => {
		it('reconstructs trigger -> command(shell) from action: command subscription', () => {
			const subs: CueSubscription[] = [
				{
					name: 'lint-on-save',
					event: 'file.changed',
					enabled: true,
					prompt: 'npm run lint',
					action: 'command',
					command: { mode: 'shell', shell: 'npm run lint' },
					watch: 'src/**/*.ts',
					agent_id: 'session-0',
				} as CueSubscription,
			];
			const sessions: SessionInfo[] = [
				{
					id: 'session-0',
					name: 'agent-A',
					toolType: 'claude-code' as const,
					cwd: '/tmp',
					projectRoot: '/tmp',
				},
			];

			const pipelines = subscriptionsToPipelines(subs, sessions);
			expect(pipelines).toHaveLength(1);
			const trigger = pipelines[0].nodes.find((n) => n.type === 'trigger');
			const command = pipelines[0].nodes.find((n) => n.type === 'command');
			expect(trigger).toBeDefined();
			expect(command).toBeDefined();
			const data = command!.data as {
				name: string;
				mode: string;
				shell?: string;
				owningSessionId: string;
				owningSessionName: string;
			};
			expect(data.mode).toBe('shell');
			expect(data.shell).toBe('npm run lint');
			expect(data.owningSessionId).toBe('session-0');
			expect(data.owningSessionName).toBe('agent-A');
			expect(pipelines[0].edges).toHaveLength(1);
			expect(pipelines[0].edges[0].source).toBe(trigger!.id);
			expect(pipelines[0].edges[0].target).toBe(command!.id);
		});

		it('reconstructs agent -> command(cli) chain', () => {
			const subs: CueSubscription[] = [
				{
					name: 'pipe',
					event: 'time.heartbeat',
					enabled: true,
					prompt: 'do work',
					interval_minutes: 5,
					agent_id: 'session-0',
				},
				{
					// Auto-named command follows `<pipeline>-cmd-<base36>` so the
					// deserializer's base-name strip groups it with the parent pipeline.
					name: 'pipe-cmd-abc12',
					event: 'agent.completed',
					enabled: true,
					prompt: 'session-research',
					action: 'command',
					command: {
						mode: 'cli',
						cli: { command: 'send', target: '{{CUE_FROM_AGENT}}' },
					},
					source_session: 'researcher',
					agent_id: 'session-0',
				} as CueSubscription,
			];
			const sessions: SessionInfo[] = [
				{
					id: 'session-0',
					name: 'researcher',
					toolType: 'claude-code' as const,
					cwd: '/tmp',
					projectRoot: '/tmp',
				},
			];

			const pipelines = subscriptionsToPipelines(subs, sessions);
			expect(pipelines).toHaveLength(1);
			const commandNode = pipelines[0].nodes.find((n) => n.type === 'command');
			const agentNode = pipelines[0].nodes.find((n) => n.type === 'agent');
			expect(commandNode).toBeDefined();
			expect(agentNode).toBeDefined();
			const data = commandNode!.data as {
				mode: string;
				cliCommand?: string;
				cliTarget?: string;
			};
			expect(data.mode).toBe('cli');
			expect(data.cliCommand).toBe('send');
			expect(data.cliTarget).toBe('{{CUE_FROM_AGENT}}');
			const edge = pipelines[0].edges.find(
				(e) => e.source === agentNode!.id && e.target === commandNode!.id
			);
			expect(edge).toBeDefined();
		});

		it('silently migrates legacy cli_output: { target } into a downstream command(cli) node', () => {
			const subs: CueSubscription[] = [
				{
					name: 'old-pipe',
					event: 'time.heartbeat',
					enabled: true,
					prompt: 'do work',
					interval_minutes: 5,
					agent_id: 'session-0',
					cli_output: { target: 'session-downstream' },
				} as CueSubscription,
			];
			const sessions: SessionInfo[] = [
				{
					id: 'session-0',
					name: 'agent-A',
					toolType: 'claude-code' as const,
					cwd: '/tmp',
					projectRoot: '/tmp',
				},
			];

			const pipelines = subscriptionsToPipelines(subs, sessions);
			expect(pipelines).toHaveLength(1);
			const commandNode = pipelines[0].nodes.find((n) => n.type === 'command');
			expect(commandNode).toBeDefined();
			const data = commandNode!.data as {
				mode: string;
				cliCommand?: string;
				cliTarget?: string;
				owningSessionId: string;
			};
			expect(data.mode).toBe('cli');
			expect(data.cliCommand).toBe('send');
			expect(data.cliTarget).toBe('session-downstream');
			expect(data.owningSessionId).toBe('session-0');
			// Edge from the agent (the upstream of the old cli_output) to the new command node.
			const agentNode = pipelines[0].nodes.find((n) => n.type === 'agent');
			expect(agentNode).toBeDefined();
			expect(
				pipelines[0].edges.some((e) => e.source === agentNode!.id && e.target === commandNode!.id)
			).toBe(true);
		});
	});
});

describe('trigger node subscriptionName population', () => {
	// Regression guard for the "GitHub chain trigger Play button fires the
	// wrong sub" bug. Every trigger node must carry the subscription name it
	// represents so the UI can fire the correct sub — using pipeline.name
	// alone only matched the first trigger, leaving chain triggers (GitHub
	// PR/Issue polls, scheduled, etc.) unreachable from the editor.
	it('stamps each trigger node with its owning subscription name', () => {
		const subs: CueSubscription[] = [
			{
				name: 'Pipeline 1',
				event: 'app.startup',
				enabled: true,
				prompt: 'startup',
				agent_id: 's1',
				pipeline_name: 'Pipeline 1',
			},
			{
				name: 'Pipeline 1-chain-1',
				event: 'time.scheduled',
				enabled: true,
				prompt: 'scheduled',
				schedule_times: ['00:00'],
				agent_id: 's1',
				pipeline_name: 'Pipeline 1',
			},
			{
				name: 'Pipeline 1-chain-2',
				event: 'github.pull_request',
				enabled: true,
				prompt: 'review PR',
				repo: 'owner/repo',
				poll_minutes: 1,
				agent_id: 's1',
				pipeline_name: 'Pipeline 1',
			},
		];
		const sessions = [
			{
				id: 's1',
				name: 'Worker',
				toolType: 'claude-code' as const,
				cwd: '/tmp',
				projectRoot: '/tmp',
			},
		];

		const pipelines = subscriptionsToPipelines(subs, sessions);
		expect(pipelines).toHaveLength(1);

		const triggerNodes = pipelines[0].nodes.filter((n) => n.type === 'trigger');
		expect(triggerNodes).toHaveLength(3);

		const subNames = triggerNodes
			.map((n) => (n.data as { subscriptionName?: string }).subscriptionName)
			.sort();
		expect(subNames).toEqual(['Pipeline 1', 'Pipeline 1-chain-1', 'Pipeline 1-chain-2']);
	});

	it('single-trigger pipelines also stamp the subscription name on the trigger node', () => {
		const subs: CueSubscription[] = [
			{
				name: 'solo',
				event: 'app.startup',
				enabled: true,
				prompt: 'x',
				agent_id: 's1',
				pipeline_name: 'solo',
			},
		];
		const sessions = [
			{
				id: 's1',
				name: 'agent',
				toolType: 'claude-code' as const,
				cwd: '/tmp',
				projectRoot: '/tmp',
			},
		];

		const pipelines = subscriptionsToPipelines(subs, sessions);
		const triggerNode = pipelines[0].nodes.find((n) => n.type === 'trigger')!;
		expect((triggerNode.data as { subscriptionName?: string }).subscriptionName).toBe('solo');
	});
});

describe('subscriptionsToPipelines — parallel branch subs share a trigger node', () => {
	// The serializer emits `Schedule → [Cmd1, Cmd2]` as two independent
	// subscriptions that share the trigger event config but name distinct
	// targets. On load, those subs must collapse back onto a single visual
	// trigger with two outgoing edges — otherwise the graph grows a phantom
	// trigger per reload and confuses the user.

	it('groups command-branch subs under one trigger when event config matches', () => {
		const subs: CueSubscription[] = [
			{
				name: 'run-script-1',
				event: 'time.scheduled',
				enabled: true,
				prompt: './script1.sh',
				action: 'command',
				command: { mode: 'shell', shell: './script1.sh' },
				schedule_times: ['07:00'],
				agent_id: 'session-0',
				pipeline_name: 'Pipeline 1',
			},
			{
				name: 'run-script-2',
				event: 'time.scheduled',
				enabled: true,
				prompt: './script2.sh',
				action: 'command',
				command: { mode: 'shell', shell: './script2.sh' },
				schedule_times: ['07:00'],
				agent_id: 'session-1',
				pipeline_name: 'Pipeline 1',
			},
		];
		const sessions = makeSessions('Cue Test 1', 'Cue Test 2');

		const pipelines = subscriptionsToPipelines(subs, sessions);
		expect(pipelines).toHaveLength(1);

		const triggers = pipelines[0].nodes.filter((n) => n.type === 'trigger');
		const commands = pipelines[0].nodes.filter((n) => n.type === 'command');
		// Collapsed onto a single trigger, two outgoing edges to two commands.
		expect(triggers).toHaveLength(1);
		expect(commands).toHaveLength(2);
		const triggerId = triggers[0].id;
		const edgesFromTrigger = pipelines[0].edges.filter((e) => e.source === triggerId);
		expect(edgesFromTrigger).toHaveLength(2);
	});

	it('keeps triggers separate when event config diverges', () => {
		// A pipeline that legitimately has two independent triggers (different
		// schedule times) must NOT be collapsed — the grouping is keyed on
		// identical event config, not on pipeline name alone.
		const subs: CueSubscription[] = [
			{
				name: 'morning',
				event: 'time.scheduled',
				enabled: true,
				prompt: 'morning work',
				schedule_times: ['07:00'],
				agent_id: 'session-0',
				pipeline_name: 'Pipeline 1',
			},
			{
				name: 'evening',
				event: 'time.scheduled',
				enabled: true,
				prompt: 'evening work',
				schedule_times: ['19:00'],
				agent_id: 'session-0',
				pipeline_name: 'Pipeline 1',
			},
		];
		const sessions = makeSessions('worker');

		const pipelines = subscriptionsToPipelines(subs, sessions);
		const triggers = pipelines[0].nodes.filter((n) => n.type === 'trigger');
		expect(triggers).toHaveLength(2);
	});
});

describe('subscriptionsToPipelines — chain subs resolve upstream via source_sub', () => {
	// Regression guard for the `Cmd(owner=S) → Agent(S)` class of pipeline.
	// Without source_sub-aware resolution, yamlToPipeline routed the chain's
	// source via session-name lookup — which matched either the agent sharing
	// that session or invented a phantom agent node, producing a self-loop
	// edge and leaving the Cmd → Agent connection missing on the canvas.

	function commandAgentMainYaml(): CueSubscription[] {
		// Mirrors what pipelineToYaml produces for:
		//   Schedule ─┬─> Cmd1(owner=S1) ─> Agent1(S1) ─┐
		//             └─> Cmd2(owner=S2) ─> Agent2(S2) ─┴─> Main(S3)
		return [
			{
				name: 'Pipeline 1-cmd-a',
				event: 'time.scheduled',
				enabled: true,
				prompt: './script1.sh',
				action: 'command',
				command: { mode: 'shell', shell: './script1.sh' },
				schedule_times: ['07:00'],
				agent_id: 'session-0',
				pipeline_name: 'Pipeline 1',
			},
			{
				name: 'Pipeline 1-cmd-b',
				event: 'time.scheduled',
				enabled: true,
				prompt: './script2.sh',
				action: 'command',
				command: { mode: 'shell', shell: './script2.sh' },
				schedule_times: ['07:00'],
				agent_id: 'session-1',
				pipeline_name: 'Pipeline 1',
			},
			{
				name: 'Pipeline 1-chain-1',
				event: 'agent.completed',
				enabled: true,
				prompt: 'report output',
				source_session: 'Cue Test 1',
				source_session_ids: 'session-0',
				source_sub: 'Pipeline 1-cmd-a',
				agent_id: 'session-0',
				pipeline_name: 'Pipeline 1',
			},
			{
				name: 'Pipeline 1-chain-2',
				event: 'agent.completed',
				enabled: true,
				prompt: 'aggregate',
				source_session: ['Cue Test 1', 'Cue Test 2'],
				source_session_ids: ['session-0', 'session-1'],
				source_sub: ['Pipeline 1-chain-1', 'Pipeline 1-chain-4'],
				agent_id: 'session-2',
				pipeline_name: 'Pipeline 1',
			},
			{
				name: 'Pipeline 1-chain-4',
				event: 'agent.completed',
				enabled: true,
				prompt: 'report output',
				source_session: 'Cue Test 2',
				source_session_ids: 'session-1',
				source_sub: 'Pipeline 1-cmd-b',
				agent_id: 'session-1',
				pipeline_name: 'Pipeline 1',
			},
		];
	}

	it('creates the complete graph shape and no phantom/self-loop edges', () => {
		const subs = commandAgentMainYaml();
		const sessions = makeSessions('Cue Test 1', 'Cue Test 2', 'Cue Test Main');

		const pipelines = subscriptionsToPipelines(subs, sessions);
		expect(pipelines).toHaveLength(1);
		const p = pipelines[0];

		const triggers = p.nodes.filter((n) => n.type === 'trigger');
		const commands = p.nodes.filter((n) => n.type === 'command');
		const agents = p.nodes.filter((n) => n.type === 'agent');
		const errors = p.nodes.filter((n) => n.type === 'error');

		// Must not collapse or duplicate: one trigger, two commands, three
		// agents (Test 1, Test 2, Main). Before the source_sub fix, chain-1
		// and chain-4 invented extra agent nodes that overlapped the command
		// nodes, and chain-2's sources fell back to session-name lookup and
		// sometimes matched the same invented agents.
		expect(triggers).toHaveLength(1);
		expect(commands).toHaveLength(2);
		expect(agents).toHaveLength(3);
		expect(errors).toHaveLength(0);

		const agentNames = agents.map((a) => (a.data as AgentNodeData).sessionName).sort();
		expect(agentNames).toEqual(['Cue Test 1', 'Cue Test 2', 'Cue Test Main']);

		// No edge may connect a node to itself. Self-loops were the visual
		// symptom of the old session-name resolver picking the same node
		// for both source and target.
		for (const edge of p.edges) {
			expect(edge.source).not.toBe(edge.target);
		}
	});

	it('wires the Cmd → Agent edges through source_sub', () => {
		const subs = commandAgentMainYaml();
		const sessions = makeSessions('Cue Test 1', 'Cue Test 2', 'Cue Test Main');

		const pipelines = subscriptionsToPipelines(subs, sessions);
		const p = pipelines[0];

		const commands = p.nodes.filter((n) => n.type === 'command');
		const agents = p.nodes.filter((n) => n.type === 'agent');
		const cmd1 = commands.find((n) => (n.data as CommandNodeData).name === 'Pipeline 1-cmd-a')!;
		const cmd2 = commands.find((n) => (n.data as CommandNodeData).name === 'Pipeline 1-cmd-b')!;
		const agent1 = agents.find((n) => (n.data as AgentNodeData).sessionName === 'Cue Test 1')!;
		const agent2 = agents.find((n) => (n.data as AgentNodeData).sessionName === 'Cue Test 2')!;
		const main = agents.find((n) => (n.data as AgentNodeData).sessionName === 'Cue Test Main')!;

		const edgeExists = (from: PipelineNode, to: PipelineNode) =>
			p.edges.some((e) => e.source === from.id && e.target === to.id);

		expect(edgeExists(cmd1, agent1)).toBe(true);
		expect(edgeExists(cmd2, agent2)).toBe(true);
		expect(edgeExists(agent1, main)).toBe(true);
		expect(edgeExists(agent2, main)).toBe(true);
		// And the trigger must fan out to BOTH commands, not fewer.
		const trigger = p.nodes.find((n) => n.type === 'trigger')!;
		expect(edgeExists(trigger, cmd1)).toBe(true);
		expect(edgeExists(trigger, cmd2)).toBe(true);
	});
});
