/**
 * Tests for pipelineToYaml conversion utilities.
 *
 * Verifies that visual pipeline graphs correctly convert to
 * CueSubscription objects and YAML strings.
 */

import { describe, it, expect } from 'vitest';
import {
	pipelineToYamlSubscriptions,
	pipelinesToYaml,
} from '../../../../../renderer/components/CuePipelineEditor/utils/pipelineToYaml';
import type { CuePipeline } from '../../../../../shared/cue-pipeline-types';

function makePipeline(overrides: Partial<CuePipeline> = {}): CuePipeline {
	return {
		id: 'p1',
		name: 'test-pipeline',
		color: '#06b6d4',
		nodes: [],
		edges: [],
		...overrides,
	};
}

describe('pipelineToYamlSubscriptions', () => {
	it('returns empty array for pipeline with no nodes', () => {
		const pipeline = makePipeline();
		expect(pipelineToYamlSubscriptions(pipeline)).toEqual([]);
	});

	it('returns empty array for trigger with no outgoing edges', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: {
						eventType: 'time.heartbeat',
						label: 'Scheduled',
						config: { interval_minutes: 5 },
					},
				},
			],
		});
		expect(pipelineToYamlSubscriptions(pipeline)).toEqual([]);
	});

	it('converts simple trigger -> agent chain', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: {
						eventType: 'time.heartbeat',
						label: 'Scheduled',
						config: { interval_minutes: 10 },
					},
				},
				{
					id: 'agent-1',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 's1',
						sessionName: 'worker',
						toolType: 'claude-code',
						inputPrompt: 'Do the work',
					},
				},
			],
			edges: [{ id: 'e1', source: 'trigger-1', target: 'agent-1', mode: 'pass' }],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		expect(subs).toHaveLength(1);
		expect(subs[0].name).toBe('test-pipeline');
		expect(subs[0].event).toBe('time.heartbeat');
		expect(subs[0].interval_minutes).toBe(10);
		expect(subs[0].prompt).toBe('Do the work');
	});

	it('converts trigger -> agent1 -> agent2 chain', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 't1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: {
						eventType: 'file.changed',
						label: 'File Change',
						config: { watch: 'src/**/*.ts' },
					},
				},
				{
					id: 'a1',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 's1',
						sessionName: 'builder',
						toolType: 'claude-code',
						inputPrompt: 'Build it',
					},
				},
				{
					id: 'a2',
					type: 'agent',
					position: { x: 600, y: 0 },
					data: {
						sessionId: 's2',
						sessionName: 'tester',
						toolType: 'claude-code',
						inputPrompt: 'Test it',
					},
				},
			],
			edges: [
				{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' },
				{ id: 'e2', source: 'a1', target: 'a2', mode: 'pass' },
			],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		expect(subs).toHaveLength(2);

		expect(subs[0].name).toBe('test-pipeline');
		expect(subs[0].event).toBe('file.changed');
		expect(subs[0].watch).toBe('src/**/*.ts');
		expect(subs[0].prompt).toBe('Build it');

		expect(subs[1].name).toBe('test-pipeline-chain-1');
		expect(subs[1].event).toBe('agent.completed');
		expect(subs[1].source_session).toBe('builder');
		expect(subs[1].prompt).toBe('Test it');
	});

	it('handles fan-out (trigger -> [agent1, agent2])', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 't1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: {
						eventType: 'time.heartbeat',
						label: 'Scheduled',
						config: { interval_minutes: 30 },
					},
				},
				{
					id: 'a1',
					type: 'agent',
					position: { x: 300, y: -100 },
					data: {
						sessionId: 's1',
						sessionName: 'worker-a',
						toolType: 'claude-code',
						inputPrompt: 'Task A',
					},
				},
				{
					id: 'a2',
					type: 'agent',
					position: { x: 300, y: 100 },
					data: {
						sessionId: 's2',
						sessionName: 'worker-b',
						toolType: 'claude-code',
						inputPrompt: 'Task B',
					},
				},
			],
			edges: [
				{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' },
				{ id: 'e2', source: 't1', target: 'a2', mode: 'pass' },
			],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		expect(subs).toHaveLength(1);
		expect(subs[0].fan_out).toEqual(['worker-a', 'worker-b']);
		expect(subs[0].interval_minutes).toBe(30);
	});

	it('handles fan-in ([agent1, agent2] -> agent3)', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 't1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: {
						eventType: 'time.heartbeat',
						label: 'Scheduled',
						config: { interval_minutes: 5 },
					},
				},
				{
					id: 'a1',
					type: 'agent',
					position: { x: 300, y: -100 },
					data: {
						sessionId: 's1',
						sessionName: 'worker-a',
						toolType: 'claude-code',
						inputPrompt: 'A',
					},
				},
				{
					id: 'a2',
					type: 'agent',
					position: { x: 300, y: 100 },
					data: {
						sessionId: 's2',
						sessionName: 'worker-b',
						toolType: 'claude-code',
						inputPrompt: 'B',
					},
				},
				{
					id: 'a3',
					type: 'agent',
					position: { x: 600, y: 0 },
					data: {
						sessionId: 's3',
						sessionName: 'aggregator',
						toolType: 'claude-code',
						inputPrompt: 'Combine',
					},
				},
			],
			edges: [
				{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' },
				{ id: 'e2', source: 't1', target: 'a2', mode: 'pass' },
				{ id: 'e3', source: 'a1', target: 'a3', mode: 'pass' },
				{ id: 'e4', source: 'a2', target: 'a3', mode: 'pass' },
			],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);

		// Find the fan-in subscription (the one targeting aggregator)
		const fanInSub = subs.find((s) => s.source_session && Array.isArray(s.source_session));
		expect(fanInSub).toBeDefined();
		expect(fanInSub!.event).toBe('agent.completed');
		expect(fanInSub!.source_session).toEqual(['worker-a', 'worker-b']);
		expect(fanInSub!.prompt).toBe('Combine');
	});

	it('maps github.pull_request trigger config', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 't1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: {
						eventType: 'github.pull_request',
						label: 'PR',
						config: { repo: 'owner/repo', poll_minutes: 5 },
					},
				},
				{
					id: 'a1',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 's1',
						sessionName: 'reviewer',
						toolType: 'claude-code',
						inputPrompt: 'Review PR',
					},
				},
			],
			edges: [{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		expect(subs[0].repo).toBe('owner/repo');
		expect(subs[0].poll_minutes).toBe(5);
		expect(subs[0].event).toBe('github.pull_request');
	});

	it('maps task.pending trigger config', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 't1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: {
						eventType: 'task.pending',
						label: 'Task',
						config: { watch: 'docs/**/*.md' },
					},
				},
				{
					id: 'a1',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 's1',
						sessionName: 'tasker',
						toolType: 'claude-code',
						inputPrompt: 'Complete tasks',
					},
				},
			],
			edges: [{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		expect(subs[0].watch).toBe('docs/**/*.md');
		expect(subs[0].event).toBe('task.pending');
	});
});

describe('pipelinesToYaml', () => {
	it('produces valid YAML with prompt_file references', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 't1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: {
						eventType: 'time.heartbeat',
						label: 'Scheduled',
						config: { interval_minutes: 15 },
					},
				},
				{
					id: 'a1',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 's1',
						sessionName: 'worker',
						toolType: 'claude-code',
						inputPrompt: 'Do stuff',
					},
				},
			],
			edges: [{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }],
		});

		const { yaml: yamlStr, promptFiles } = pipelinesToYaml([pipeline]);
		expect(yamlStr).toContain('# Pipeline: test-pipeline (color: #06b6d4)');
		expect(yamlStr).toContain('subscriptions:');
		expect(yamlStr).toContain('name: test-pipeline');
		expect(yamlStr).toContain('event: time.heartbeat');
		expect(yamlStr).toContain('interval_minutes: 15');
		expect(yamlStr).toContain('prompt_file: .maestro/prompts/worker-test-pipeline.md');
		expect(yamlStr).not.toContain('prompt: Do stuff');

		// Prompt content saved to external file
		expect(promptFiles.get('.maestro/prompts/worker-test-pipeline.md')).toBe('Do stuff');
	});

	it('includes settings block when provided', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 't1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: { eventType: 'time.heartbeat', label: 'Timer', config: { interval_minutes: 5 } },
				},
				{
					id: 'a1',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: { sessionId: 's1', sessionName: 'w', toolType: 'claude-code', inputPrompt: 'go' },
				},
			],
			edges: [{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }],
		});

		const { yaml: yamlStr } = pipelinesToYaml([pipeline], {
			timeout_minutes: 60,
			max_concurrent: 3,
		});
		expect(yamlStr).toContain('settings:');
		expect(yamlStr).toContain('timeout_minutes: 60');
		expect(yamlStr).toContain('max_concurrent: 3');
	});

	it('adds debate mode edge comment', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 't1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: { eventType: 'time.heartbeat', label: 'Timer', config: { interval_minutes: 5 } },
				},
				{
					id: 'a1',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 's1',
						sessionName: 'debater',
						toolType: 'claude-code',
						inputPrompt: 'argue',
					},
				},
			],
			edges: [
				{
					id: 'e1',
					source: 't1',
					target: 'a1',
					mode: 'debate' as const,
					debateConfig: { maxRounds: 5, timeoutPerRound: 120 },
				},
			],
		});

		const { yaml: yamlStr } = pipelinesToYaml([pipeline]);
		expect(yamlStr).toContain('mode: debate, max_rounds: 5, timeout_per_round: 120');
	});

	it('handles multiple pipelines', () => {
		const p1 = makePipeline({
			id: 'p1',
			name: 'pipeline-a',
			color: '#06b6d4',
			nodes: [
				{
					id: 't1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: { eventType: 'time.heartbeat', label: 'Timer', config: { interval_minutes: 5 } },
				},
				{
					id: 'a1',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 's1',
						sessionName: 'w1',
						toolType: 'claude-code',
						inputPrompt: 'go 1',
					},
				},
			],
			edges: [{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }],
		});

		const p2 = makePipeline({
			id: 'p2',
			name: 'pipeline-b',
			color: '#8b5cf6',
			nodes: [
				{
					id: 't2',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: { eventType: 'file.changed', label: 'Files', config: { watch: '**/*.md' } },
				},
				{
					id: 'a2',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 's2',
						sessionName: 'w2',
						toolType: 'claude-code',
						inputPrompt: 'go 2',
					},
				},
			],
			edges: [{ id: 'e2', source: 't2', target: 'a2', mode: 'pass' }],
		});

		const { yaml: yamlStr } = pipelinesToYaml([p1, p2]);
		expect(yamlStr).toContain('# Pipeline: pipeline-a');
		expect(yamlStr).toContain('# Pipeline: pipeline-b');
		expect(yamlStr).toContain('name: pipeline-a');
		expect(yamlStr).toContain('name: pipeline-b');
	});

	it('returns empty subscriptions for empty pipelines array', () => {
		const { yaml: yamlStr } = pipelinesToYaml([]);
		expect(yamlStr).toContain('subscriptions: []');
	});

	it('includes agent_id from agent node sessionId', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 't1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: { eventType: 'time.heartbeat', label: 'Timer', config: { interval_minutes: 5 } },
				},
				{
					id: 'a1',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 'uuid-abc-123',
						sessionName: 'worker',
						toolType: 'claude-code',
						inputPrompt: 'go',
					},
				},
			],
			edges: [{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }],
		});

		const { yaml: yamlStr } = pipelinesToYaml([pipeline]);
		expect(yamlStr).toContain('agent_id: uuid-abc-123');
	});

	it('includes agent_id for each agent in a chain', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 't1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: { eventType: 'file.changed', label: 'Files', config: { watch: '**/*' } },
				},
				{
					id: 'a1',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 'id-builder',
						sessionName: 'builder',
						toolType: 'claude-code',
						inputPrompt: 'build',
					},
				},
				{
					id: 'a2',
					type: 'agent',
					position: { x: 600, y: 0 },
					data: {
						sessionId: 'id-tester',
						sessionName: 'tester',
						toolType: 'claude-code',
						inputPrompt: 'test',
					},
				},
			],
			edges: [
				{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' },
				{ id: 'e2', source: 'a1', target: 'a2', mode: 'pass' },
			],
		});

		const { yaml: yamlStr } = pipelinesToYaml([pipeline]);
		expect(yamlStr).toContain('agent_id: id-builder');
		expect(yamlStr).toContain('agent_id: id-tester');
	});

	it('saves output_prompt to separate file with -output suffix', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 't1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: { eventType: 'time.heartbeat', label: 'Timer', config: { interval_minutes: 5 } },
				},
				{
					id: 'a1',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 's1',
						sessionName: 'worker',
						toolType: 'claude-code',
						inputPrompt: 'Do work',
						outputPrompt: 'Summarize output',
					},
				},
			],
			edges: [{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }],
		});

		const { yaml: yamlStr, promptFiles } = pipelinesToYaml([pipeline]);
		expect(yamlStr).toContain('prompt_file: .maestro/prompts/worker-test-pipeline.md');
		expect(yamlStr).toContain(
			'output_prompt_file: .maestro/prompts/worker-test-pipeline-output.md'
		);
		expect(promptFiles.get('.maestro/prompts/worker-test-pipeline.md')).toBe('Do work');
		expect(promptFiles.get('.maestro/prompts/worker-test-pipeline-output.md')).toBe(
			'Summarize output'
		);
	});

	it('uses edge prompt when available instead of agent node prompt', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 't1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: { eventType: 'time.heartbeat', label: 'Timer', config: { interval_minutes: 5 } },
				},
				{
					id: 'a1',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 's1',
						sessionName: 'worker',
						toolType: 'claude-code',
						inputPrompt: 'node-level prompt',
					},
				},
			],
			edges: [
				{
					id: 'e1',
					source: 't1',
					target: 'a1',
					mode: 'pass' as const,
					prompt: 'edge-level prompt',
				},
			],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		expect(subs).toHaveLength(1);
		expect(subs[0].prompt).toBe('edge-level prompt');
	});

	it('serializes trigger customLabel as subscription label', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 't1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: {
						eventType: 'time.scheduled',
						label: 'Scheduled',
						customLabel: 'Morning Check',
						config: { schedule_times: ['08:30'] },
					},
				},
				{
					id: 'a1',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 's1',
						sessionName: 'worker',
						toolType: 'claude-code',
						inputPrompt: 'Check stuff',
					},
				},
			],
			edges: [{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' as const }],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		expect(subs[0].label).toBe('Morning Check');
	});

	it('creates separate subscriptions for multiple triggers targeting same agent with edge prompts', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 't1',
					type: 'trigger',
					position: { x: 0, y: -100 },
					data: {
						eventType: 'time.scheduled',
						label: 'Scheduled',
						customLabel: 'Morning',
						config: { schedule_times: ['08:30'] },
					},
				},
				{
					id: 't2',
					type: 'trigger',
					position: { x: 0, y: 100 },
					data: {
						eventType: 'time.scheduled',
						label: 'Scheduled',
						customLabel: 'Evening',
						config: { schedule_times: ['17:30'] },
					},
				},
				{
					id: 'a1',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 's1',
						sessionName: 'worker',
						toolType: 'claude-code',
					},
				},
			],
			edges: [
				{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' as const, prompt: 'Morning routine' },
				{ id: 'e2', source: 't2', target: 'a1', mode: 'pass' as const, prompt: 'Evening wrap-up' },
			],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		expect(subs).toHaveLength(2);
		expect(subs[0].prompt).toBe('Morning routine');
		expect(subs[0].label).toBe('Morning');
		expect(subs[0].schedule_times).toEqual(['08:30']);
		expect(subs[1].prompt).toBe('Evening wrap-up');
		expect(subs[1].label).toBe('Evening');
		expect(subs[1].schedule_times).toEqual(['17:30']);
	});

	it('generates unique prompt file paths for multiple triggers targeting same agent', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 't1',
					type: 'trigger',
					position: { x: 0, y: -100 },
					data: {
						eventType: 'time.scheduled',
						label: 'Scheduled',
						config: { schedule_times: ['08:30'] },
					},
				},
				{
					id: 't2',
					type: 'trigger',
					position: { x: 0, y: 100 },
					data: {
						eventType: 'time.scheduled',
						label: 'Scheduled',
						config: { schedule_times: ['17:30'] },
					},
				},
				{
					id: 'a1',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 's1',
						sessionName: 'worker',
						toolType: 'claude-code',
					},
				},
			],
			edges: [
				{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' as const, prompt: 'Prompt A' },
				{ id: 'e2', source: 't2', target: 'a1', mode: 'pass' as const, prompt: 'Prompt B' },
			],
		});

		const { promptFiles } = pipelinesToYaml([pipeline]);
		// Should have 2 distinct prompt files, not overwrite
		const promptEntries = [...promptFiles.entries()].filter(
			([, content]) => content === 'Prompt A' || content === 'Prompt B'
		);
		expect(promptEntries).toHaveLength(2);
		expect(promptEntries[0][0]).not.toBe(promptEntries[1][0]); // Different file paths
	});
});
