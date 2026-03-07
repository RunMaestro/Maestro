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
				event: 'time.interval',
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
			eventType: 'time.interval',
			config: { interval_minutes: 10 },
		});

		// Agent should have the prompt
		expect(agents[0].data).toMatchObject({
			sessionName: 'worker',
			prompt: 'Do the work',
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
				event: 'time.interval',
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
				event: 'time.interval',
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
				event: 'time.interval',
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
				event: 'time.interval',
				enabled: true,
				prompt: 'A',
				interval_minutes: 5,
			},
			{
				name: 'p2',
				event: 'time.interval',
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
				event: 'time.interval',
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
				event: 'time.interval',
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

	it('sets default edge mode to pass', () => {
		const subs: CueSubscription[] = [
			{
				name: 'mode-test',
				event: 'time.interval',
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
						event: 'time.interval',
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
			eventType: 'time.interval',
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
});
