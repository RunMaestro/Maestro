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
	ensureSourceOutputVariable,
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
		expect(subs[1].prompt).toBe('{{CUE_SOURCE_OUTPUT}}\n\nTest it');
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
		expect(fanInSub!.prompt).toBe('{{CUE_SOURCE_OUTPUT}}\n\nCombine');
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
		// Pipeline identity is carried by the `pipeline_name` / `pipeline_color`
		// fields on each subscription (authoritative, round-tripped). The
		// human-only `# Pipeline: X (color: Y)` header was removed to
		// eliminate the duplicate source of truth.
		expect(yamlStr).toContain('pipeline_name: test-pipeline');
		expect(yamlStr).toContain("pipeline_color: '#06b6d4'");
		expect(yamlStr).toContain('subscriptions:');
		expect(yamlStr).toContain('name: test-pipeline');
		expect(yamlStr).toContain('event: time.heartbeat');
		expect(yamlStr).toContain('interval_minutes: 15');
		expect(yamlStr).toContain('prompt_file: .maestro/prompts/worker-test-pipeline.md');
		expect(yamlStr).not.toContain('prompt: Do stuff');

		// Prompt content saved to external file
		expect(promptFiles.get('.maestro/prompts/worker-test-pipeline.md')).toBe('Do stuff');
	});

	it('writes prompt: "" inline when the subscription has no prompt (defensive)', () => {
		// Empty prompts can reach pipelinesToYaml if a debounce race wipes the
		// node's inputPrompt before handleSave reads state. Without the
		// inline-empty fallback, the loader-side validator rejects the whole
		// YAML ("prompt or prompt_file is required") and the user sees their
		// pipeline "vanish" on the next modal open. Writing an empty string
		// keeps the YAML valid so the editor can reload it and surface a
		// proper "missing prompt" validation error on the next save attempt.
		const pipeline = makePipeline({
			nodes: [
				{
					id: 't1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: {
						eventType: 'time.heartbeat',
						label: 'Timer',
						config: { interval_minutes: 5 },
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
						inputPrompt: '',
					},
				},
			],
			edges: [{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }],
		});

		const { yaml: yamlStr, promptFiles } = pipelinesToYaml([pipeline]);
		expect(yamlStr).toContain("prompt: ''");
		expect(yamlStr).not.toContain('prompt_file:');
		expect(promptFiles.size).toBe(0);
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
		expect(yamlStr).toContain('pipeline_name: pipeline-a');
		expect(yamlStr).toContain('pipeline_name: pipeline-b');
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

describe('includeUpstreamOutput toggle', () => {
	it('respects includeUpstreamOutput: false by not injecting variable', () => {
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
						sessionId: 's1',
						sessionName: 'builder',
						toolType: 'claude-code',
						inputPrompt: 'Build',
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
						inputPrompt: 'Test only',
						includeUpstreamOutput: false,
					},
				},
			],
			edges: [
				{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' },
				{ id: 'e2', source: 'a1', target: 'a2', mode: 'pass' },
			],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		expect(subs[1].prompt).toBe('Test only');
	});

	it('injects variable when includeUpstreamOutput is explicitly true', () => {
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
						sessionId: 's1',
						sessionName: 'builder',
						toolType: 'claude-code',
						inputPrompt: 'Build',
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
						includeUpstreamOutput: true,
					},
				},
			],
			edges: [
				{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' },
				{ id: 'e2', source: 'a1', target: 'a2', mode: 'pass' },
			],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		expect(subs[1].prompt).toBe('{{CUE_SOURCE_OUTPUT}}\n\nTest it');
	});
});

describe('ensureSourceOutputVariable', () => {
	it('auto-injects when prompt is missing it', () => {
		expect(ensureSourceOutputVariable('Review the code')).toBe(
			'{{CUE_SOURCE_OUTPUT}}\n\nReview the code'
		);
	});

	it('preserves existing {{CUE_SOURCE_OUTPUT}} in prompt', () => {
		const prompt = 'Here is the output: {{CUE_SOURCE_OUTPUT}}\n\nNow review.';
		expect(ensureSourceOutputVariable(prompt)).toBe(prompt);
	});

	it('returns bare variable for empty prompt', () => {
		expect(ensureSourceOutputVariable('')).toBe('{{CUE_SOURCE_OUTPUT}}');
	});

	it('returns bare variable for whitespace-only prompt', () => {
		expect(ensureSourceOutputVariable('   ')).toBe('{{CUE_SOURCE_OUTPUT}}');
	});

	it('case-insensitive check avoids double injection', () => {
		const prompt = 'Use {{cue_source_output}} here';
		expect(ensureSourceOutputVariable(prompt)).toBe(prompt);
	});
});

describe('chain agent with empty prompt', () => {
	it('generates {{CUE_SOURCE_OUTPUT}} prompt for chain agent with empty inputPrompt', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: { eventType: 'file.changed', label: 'File Change', config: { watch: '**/*' } },
				},
				{
					id: 'agent-1',
					type: 'agent',
					position: { x: 200, y: 0 },
					data: {
						sessionId: 's1',
						sessionName: 'builder',
						toolType: 'claude-code',
						inputPrompt: 'Build the project',
					},
				},
				{
					id: 'agent-2',
					type: 'agent',
					position: { x: 400, y: 0 },
					data: {
						sessionId: 's2',
						sessionName: 'tester',
						toolType: 'claude-code',
						inputPrompt: '',
					},
				},
			],
			edges: [
				{ id: 'e1', source: 'trigger-1', target: 'agent-1', mode: 'pass' },
				{ id: 'e2', source: 'agent-1', target: 'agent-2', mode: 'pass' },
			],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		const chainSub = subs.find((s) => s.event === 'agent.completed');
		expect(chainSub).toBeDefined();
		expect(chainSub!.prompt).toBe('{{CUE_SOURCE_OUTPUT}}');
		expect(chainSub!.source_session).toBe('builder');
	});

	it('generates {{CUE_SOURCE_OUTPUT}} prompt for chain agent with undefined inputPrompt', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: { eventType: 'file.changed', label: 'File Change', config: { watch: '**/*' } },
				},
				{
					id: 'agent-1',
					type: 'agent',
					position: { x: 200, y: 0 },
					data: {
						sessionId: 's1',
						sessionName: 'builder',
						toolType: 'claude-code',
						inputPrompt: 'Build',
					},
				},
				{
					id: 'agent-2',
					type: 'agent',
					position: { x: 400, y: 0 },
					data: {
						sessionId: 's2',
						sessionName: 'reviewer',
						toolType: 'claude-code',
						// inputPrompt intentionally omitted
					},
				},
			],
			edges: [
				{ id: 'e1', source: 'trigger-1', target: 'agent-1', mode: 'pass' },
				{ id: 'e2', source: 'agent-1', target: 'agent-2', mode: 'pass' },
			],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		const chainSub = subs.find((s) => s.event === 'agent.completed');
		expect(chainSub).toBeDefined();
		expect(chainSub!.prompt).toBe('{{CUE_SOURCE_OUTPUT}}');
	});
});

describe('fan-out with per-edge prompts', () => {
	it('produces fan_out_prompts when edges have different prompts', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: { eventType: 'file.changed', label: 'Files', config: { watch: 'src/**' } },
				},
				{
					id: 'agent-1',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 's1',
						sessionName: 'worker-1',
						toolType: 'claude-code',
						inputPrompt: 'default prompt 1',
					},
				},
				{
					id: 'agent-2',
					type: 'agent',
					position: { x: 300, y: 100 },
					data: {
						sessionId: 's2',
						sessionName: 'worker-2',
						toolType: 'claude-code',
						inputPrompt: 'default prompt 2',
					},
				},
			],
			edges: [
				{ id: 'e1', source: 'trigger-1', target: 'agent-1', mode: 'pass', prompt: 'edge prompt 1' },
				{ id: 'e2', source: 'trigger-1', target: 'agent-2', mode: 'pass', prompt: 'edge prompt 2' },
			],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		expect(subs).toHaveLength(1);
		expect(subs[0].fan_out).toEqual(['worker-1', 'worker-2']);
		expect(subs[0].fan_out_prompts).toEqual(['edge prompt 1', 'edge prompt 2']);
	});

	it('falls back to agent inputPrompt when edges have no prompt', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: { eventType: 'file.changed', label: 'Files', config: { watch: 'src/**' } },
				},
				{
					id: 'agent-1',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 's1',
						sessionName: 'worker-1',
						toolType: 'claude-code',
						inputPrompt: 'same prompt',
					},
				},
				{
					id: 'agent-2',
					type: 'agent',
					position: { x: 300, y: 100 },
					data: {
						sessionId: 's2',
						sessionName: 'worker-2',
						toolType: 'claude-code',
						inputPrompt: 'same prompt',
					},
				},
			],
			edges: [
				{ id: 'e1', source: 'trigger-1', target: 'agent-1', mode: 'pass' },
				{ id: 'e2', source: 'trigger-1', target: 'agent-2', mode: 'pass' },
			],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		expect(subs).toHaveLength(1);
		expect(subs[0].prompt).toBe('same prompt');
		expect(subs[0].fan_out_prompts).toBeUndefined();
	});

	it('handles mixed edge and agent prompts', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: { eventType: 'file.changed', label: 'Files', config: { watch: 'src/**' } },
				},
				{
					id: 'agent-1',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 's1',
						sessionName: 'worker-1',
						toolType: 'claude-code',
						inputPrompt: 'default prompt 1',
					},
				},
				{
					id: 'agent-2',
					type: 'agent',
					position: { x: 300, y: 100 },
					data: {
						sessionId: 's2',
						sessionName: 'worker-2',
						toolType: 'claude-code',
						inputPrompt: 'default prompt 2',
					},
				},
			],
			edges: [
				{ id: 'e1', source: 'trigger-1', target: 'agent-1', mode: 'pass', prompt: 'edge prompt 1' },
				{ id: 'e2', source: 'trigger-1', target: 'agent-2', mode: 'pass' },
			],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		expect(subs).toHaveLength(1);
		expect(subs[0].fan_out_prompts).toEqual(['edge prompt 1', 'default prompt 2']);
	});

	it('single-target pipeline has no fan_out or fan_out_prompts', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: { eventType: 'file.changed', label: 'Files', config: { watch: 'src/**' } },
				},
				{
					id: 'agent-1',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 's1',
						sessionName: 'worker-1',
						toolType: 'claude-code',
						inputPrompt: 'do work',
					},
				},
			],
			edges: [{ id: 'e1', source: 'trigger-1', target: 'agent-1', mode: 'pass' }],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		expect(subs).toHaveLength(1);
		expect(subs[0].fan_out).toBeUndefined();
		expect(subs[0].fan_out_prompts).toBeUndefined();
		expect(subs[0].prompt).toBe('do work');
	});

	it('handles duplicate agent names in fan-out', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: { eventType: 'file.changed', label: 'Files', config: { watch: 'src/**' } },
				},
				{
					id: 'agent-1',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 's1',
						sessionName: 'worker',
						toolType: 'claude-code',
						inputPrompt: 'task a',
					},
				},
				{
					id: 'agent-2',
					type: 'agent',
					position: { x: 300, y: 100 },
					data: {
						sessionId: 's2',
						sessionName: 'worker',
						toolType: 'claude-code',
						inputPrompt: 'task b',
					},
				},
			],
			edges: [
				{ id: 'e1', source: 'trigger-1', target: 'agent-1', mode: 'pass' },
				{ id: 'e2', source: 'trigger-1', target: 'agent-2', mode: 'pass' },
			],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		expect(subs).toHaveLength(1);
		expect(subs[0].fan_out).toEqual(['worker', 'worker']);
	});
});

describe('fan-out to fan-in pipeline', () => {
	function makeFanOutFanInPipeline(agentDOverrides: Record<string, unknown> = {}) {
		return makePipeline({
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: {
						eventType: 'time.scheduled',
						label: 'Morning',
						config: { schedule_times: ['09:00'] },
					},
				},
				{
					id: 'agent-a',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 'sa',
						sessionName: 'researcher-1',
						toolType: 'claude-code',
						inputPrompt: 'Research topic A',
					},
				},
				{
					id: 'agent-b',
					type: 'agent',
					position: { x: 300, y: 100 },
					data: {
						sessionId: 'sb',
						sessionName: 'researcher-2',
						toolType: 'claude-code',
						inputPrompt: 'Research topic B',
					},
				},
				{
					id: 'agent-c',
					type: 'agent',
					position: { x: 300, y: 200 },
					data: {
						sessionId: 'sc',
						sessionName: 'researcher-3',
						toolType: 'claude-code',
						inputPrompt: 'Research topic C',
					},
				},
				{
					id: 'agent-d',
					type: 'agent',
					position: { x: 600, y: 100 },
					data: {
						sessionId: 'sd',
						sessionName: 'synthesizer',
						toolType: 'claude-code',
						inputPrompt: 'Summarize all findings',
						...agentDOverrides,
					},
				},
			],
			edges: [
				{ id: 'e1', source: 'trigger-1', target: 'agent-a', mode: 'pass' },
				{ id: 'e2', source: 'trigger-1', target: 'agent-b', mode: 'pass' },
				{ id: 'e3', source: 'trigger-1', target: 'agent-c', mode: 'pass' },
				{ id: 'e4', source: 'agent-a', target: 'agent-d', mode: 'pass' },
				{ id: 'e5', source: 'agent-b', target: 'agent-d', mode: 'pass' },
				{ id: 'e6', source: 'agent-c', target: 'agent-d', mode: 'pass' },
			],
		});
	}

	it('produces source_session array for fan-in', () => {
		const pipeline = makeFanOutFanInPipeline();
		const subs = pipelineToYamlSubscriptions(pipeline);

		const fanInSub = subs.find((s) => s.source_session && Array.isArray(s.source_session));
		expect(fanInSub).toBeDefined();
		expect(fanInSub!.source_session).toEqual(['researcher-1', 'researcher-2', 'researcher-3']);
	});

	it('includes fan-in timeout fields when set', () => {
		const pipeline = makeFanOutFanInPipeline({
			fanInTimeoutMinutes: 5,
			fanInTimeoutOnFail: 'continue',
		});
		const subs = pipelineToYamlSubscriptions(pipeline);

		const fanInSub = subs.find((s) => s.source_session && Array.isArray(s.source_session));
		expect(fanInSub).toBeDefined();
		expect(fanInSub!.fan_in_timeout_minutes).toBe(5);
		expect(fanInSub!.fan_in_timeout_on_fail).toBe('continue');
	});

	it('omits fan-in timeout fields when not set', () => {
		const pipeline = makeFanOutFanInPipeline();
		const subs = pipelineToYamlSubscriptions(pipeline);

		const fanInSub = subs.find((s) => s.source_session && Array.isArray(s.source_session));
		expect(fanInSub).toBeDefined();
		expect(fanInSub!).not.toHaveProperty('fan_in_timeout_minutes');
		expect(fanInSub!).not.toHaveProperty('fan_in_timeout_on_fail');
	});
});

describe('command node serialization', () => {
	it('emits action: command with shell mode for trigger -> command(shell)', () => {
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
					id: 'cmd1',
					type: 'command',
					position: { x: 300, y: 0 },
					data: {
						name: 'lint-on-save',
						mode: 'shell',
						shell: 'npm run lint',
						owningSessionId: 'sess-A',
						owningSessionName: 'agent-A',
					},
				},
			],
			edges: [{ id: 'e1', source: 't1', target: 'cmd1', mode: 'pass' }],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		expect(subs).toHaveLength(1);
		expect(subs[0].name).toBe('lint-on-save');
		expect(subs[0].event).toBe('file.changed');
		expect(subs[0].action).toBe('command');
		expect(subs[0].command).toEqual({ mode: 'shell', shell: 'npm run lint' });
		expect(subs[0].watch).toBe('src/**/*.ts');
	});

	it('emits action: command with cli mode for trigger -> command(cli)', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 't1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: { eventType: 'cli.trigger', label: 'CLI', config: {} },
				},
				{
					id: 'cmd1',
					type: 'command',
					position: { x: 300, y: 0 },
					data: {
						name: 'forward-output',
						mode: 'cli',
						cliCommand: 'send',
						cliTarget: '{{CUE_FROM_AGENT}}',
						cliMessage: 'msg: {{CUE_SOURCE_OUTPUT}}',
						owningSessionId: 'sess-deploy',
						owningSessionName: 'deployer',
					},
				},
			],
			edges: [{ id: 'e1', source: 't1', target: 'cmd1', mode: 'pass' }],
		});

		const { yaml: out } = pipelinesToYaml([pipeline]);
		expect(out).toContain('action: command');
		expect(out).toContain('mode: cli');
		expect(out).toContain('command: send');
		expect(out).toContain("target: '{{CUE_FROM_AGENT}}'");
		expect(out).toContain("message: 'msg: {{CUE_SOURCE_OUTPUT}}'");
		expect(out).toContain('agent_id: sess-deploy');
		// Command subs should NOT emit prompt_file.
		expect(out).not.toContain('prompt_file:');
	});

	it('chains agent -> command with source_session = upstream agent name', () => {
		const pipeline = makePipeline({
			nodes: [
				{
					id: 't1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: { eventType: 'time.heartbeat', label: 'Sched', config: { interval_minutes: 10 } },
				},
				{
					id: 'a1',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 's-agent',
						sessionName: 'researcher',
						toolType: 'claude-code',
						inputPrompt: 'go',
					},
				},
				{
					id: 'cmd1',
					type: 'command',
					position: { x: 600, y: 0 },
					data: {
						name: 'persist',
						mode: 'shell',
						shell: 'echo done >> log.txt',
						owningSessionId: 's-agent',
						owningSessionName: 'researcher',
					},
				},
			],
			edges: [
				{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' },
				{ id: 'e2', source: 'a1', target: 'cmd1', mode: 'pass' },
			],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		expect(subs).toHaveLength(2);
		const cmdSub = subs.find((s) => s.action === 'command');
		expect(cmdSub).toBeDefined();
		expect(cmdSub!.name).toBe('persist');
		expect(cmdSub!.event).toBe('agent.completed');
		expect(cmdSub!.source_session).toBe('researcher');
		expect(cmdSub!.command).toEqual({ mode: 'shell', shell: 'echo done >> log.txt' });
	});

	describe('unbound command nodes', () => {
		it('excludes unbound commands dropped from the standalone pill', () => {
			// Pipeline validation flags this case at save time; this is a
			// defense-in-depth check that YAML output never contains a
			// subscription with an empty agent_id. Without the filter the engine
			// would reject the whole config on load.
			const pipeline = makePipeline({
				nodes: [
					{
						id: 't1',
						type: 'trigger',
						position: { x: 0, y: 0 },
						data: {
							eventType: 'time.heartbeat',
							label: 'tick',
							config: { interval_minutes: 1 },
						},
					},
					{
						id: 'cmd1',
						type: 'command',
						position: { x: 300, y: 0 },
						data: {
							name: 'unbound-lint',
							mode: 'shell',
							shell: 'npm run lint',
							owningSessionId: '',
							owningSessionName: '',
						},
					},
				],
				edges: [{ id: 'e1', source: 't1', target: 'cmd1', mode: 'pass' }],
			});

			const subs = pipelineToYamlSubscriptions(pipeline);
			// Unbound command is filtered; trigger becomes a dangling trigger
			// with no targets, which also yields no subscriptions.
			expect(subs).toEqual([]);
		});

		it('serializes a bound command node normally', () => {
			const pipeline = makePipeline({
				nodes: [
					{
						id: 't1',
						type: 'trigger',
						position: { x: 0, y: 0 },
						data: {
							eventType: 'time.heartbeat',
							label: 'tick',
							config: { interval_minutes: 1 },
						},
					},
					{
						id: 'cmd1',
						type: 'command',
						position: { x: 300, y: 0 },
						data: {
							name: 'bound-lint',
							mode: 'shell',
							shell: 'npm run lint',
							owningSessionId: 's-owner',
							owningSessionName: 'Lint Owner',
						},
					},
				],
				edges: [{ id: 'e1', source: 't1', target: 'cmd1', mode: 'pass' }],
			});

			const subs = pipelineToYamlSubscriptions(pipeline);
			expect(subs).toHaveLength(1);
			expect(subs[0].action).toBe('command');
			expect(subs[0].command).toEqual({ mode: 'shell', shell: 'npm run lint' });
		});
	});
});

describe('fan-out per-agent prompt externalization', () => {
	// Regression guard for the "one prompt file for three fan-out agents"
	// asymmetry: when fan-out targets have different prompts, each agent's
	// prompt must live in its own .md file (`fan_out_prompt_files`) rather
	// than being crammed into an inline `fan_out_prompts` array in the YAML.

	function makeFanOutPipeline(prompts: [string, string, string]) {
		return makePipeline({
			name: 'Pipeline 1',
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: { eventType: 'app.startup', label: 'Startup', config: {} },
				},
				{
					id: 'agent-1',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 's1',
						sessionName: 'Codex 1',
						toolType: 'codex',
						inputPrompt: prompts[0],
					},
				},
				{
					id: 'agent-2',
					type: 'agent',
					position: { x: 300, y: 100 },
					data: {
						sessionId: 's2',
						sessionName: 'OpenCode 1',
						toolType: 'opencode',
						inputPrompt: prompts[1],
					},
				},
				{
					id: 'agent-3',
					type: 'agent',
					position: { x: 300, y: 200 },
					data: {
						sessionId: 's3',
						sessionName: 'Claude 1',
						toolType: 'claude-code',
						inputPrompt: prompts[2],
					},
				},
			],
			edges: [
				{ id: 'e1', source: 'trigger-1', target: 'agent-1', mode: 'pass' },
				{ id: 'e2', source: 'trigger-1', target: 'agent-2', mode: 'pass' },
				{ id: 'e3', source: 'trigger-1', target: 'agent-3', mode: 'pass' },
			],
		});
	}

	it('emits fan_out_prompt_files (not inline fan_out_prompts) when per-agent prompts differ', () => {
		const pipeline = makeFanOutPipeline(['codex work', 'opencode work', 'claude work']);
		const { yaml: yamlStr, promptFiles } = pipelinesToYaml([pipeline]);

		expect(yamlStr).toContain('fan_out_prompt_files:');
		// Inline array MUST NOT be emitted when files take over — that was the
		// asymmetric legacy shape.
		expect(yamlStr).not.toMatch(/^\s*fan_out_prompts:/m);

		// One .md per agent, content matches.
		expect(promptFiles.get('.maestro/prompts/codex_1-pipeline_1.md')).toBe('codex work');
		expect(promptFiles.get('.maestro/prompts/opencode_1-pipeline_1.md')).toBe('opencode work');
		expect(promptFiles.get('.maestro/prompts/claude_1-pipeline_1.md')).toBe('claude work');
	});

	it('collapses to a single prompt_file when all fan-out agents share the same prompt', () => {
		const pipeline = makeFanOutPipeline(['shared', 'shared', 'shared']);
		const { yaml: yamlStr, promptFiles } = pipelinesToYaml([pipeline]);

		expect(yamlStr).toContain('prompt_file:');
		expect(yamlStr).not.toContain('fan_out_prompt_files:');
		expect(yamlStr).not.toMatch(/^\s*fan_out_prompts:/m);
		// Exactly one prompt file, content "shared".
		const entries = Array.from(promptFiles.entries());
		expect(entries).toHaveLength(1);
		expect(entries[0][1]).toBe('shared');
	});

	it('writes an empty file for agents with empty prompts to preserve positional mapping', () => {
		const pipeline = makeFanOutPipeline(['has content', '', 'also content']);
		const { promptFiles } = pipelinesToYaml([pipeline]);

		// Middle agent gets an empty file — dropping the entry would shift
		// the positional mapping against `fan_out` and mis-route prompts at
		// runtime.
		expect(promptFiles.get('.maestro/prompts/codex_1-pipeline_1.md')).toBe('has content');
		expect(promptFiles.get('.maestro/prompts/opencode_1-pipeline_1.md')).toBe('');
		expect(promptFiles.get('.maestro/prompts/claude_1-pipeline_1.md')).toBe('also content');
	});

	it('does not emit a redundant single prompt_file when per-agent files are in use', () => {
		// `sub.prompt` is retained as an engine fallback but must NOT appear
		// as `prompt_file` in the record — that would double-write the first
		// agent's prompt to two files and confuse readers.
		const pipeline = makeFanOutPipeline(['a', 'b', 'c']);
		const { yaml: yamlStr } = pipelinesToYaml([pipeline]);

		const lines = yamlStr.split('\n');
		const promptFileLines = lines.filter((l) => /^\s{4}prompt_file:/.test(l));
		expect(promptFileLines).toHaveLength(0);
	});
});

describe('fan-out with command targets (per-branch emission)', () => {
	// When a trigger fans out to command nodes, the engine's `fan_out` field
	// can't address them (commands have no session identity). The serializer
	// must emit ONE full subscription per direct target instead — each
	// re-carrying the trigger event config so they arm independently.

	function makeCommandFanOutPipeline() {
		return makePipeline({
			name: 'Pipeline 1',
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: {
						eventType: 'time.scheduled',
						label: 'Scheduled',
						config: { schedule_times: ['07:00'] },
					},
				},
				{
					id: 'cmd-1',
					type: 'command',
					position: { x: 300, y: 0 },
					data: {
						name: 'run-script-1',
						mode: 'shell',
						shell: './script1.sh',
						owningSessionId: 's1',
						owningSessionName: 'Cue Test 1',
					},
				},
				{
					id: 'cmd-2',
					type: 'command',
					position: { x: 300, y: 100 },
					data: {
						name: 'run-script-2',
						mode: 'shell',
						shell: './script2.sh',
						owningSessionId: 's2',
						owningSessionName: 'Cue Test 2',
					},
				},
				{
					id: 'agent-1',
					type: 'agent',
					position: { x: 600, y: 0 },
					data: {
						sessionId: 's1',
						sessionName: 'Cue Test 1',
						toolType: 'claude-code',
						inputPrompt: 'Report the script1 output',
					},
				},
				{
					id: 'agent-2',
					type: 'agent',
					position: { x: 600, y: 100 },
					data: {
						sessionId: 's2',
						sessionName: 'Cue Test 2',
						toolType: 'claude-code',
						inputPrompt: 'Report the script2 output',
					},
				},
				{
					id: 'agent-main',
					type: 'agent',
					position: { x: 900, y: 50 },
					data: {
						sessionId: 's-main',
						sessionName: 'Cue Test Main',
						toolType: 'claude-code',
						inputPrompt: 'Combine both reports',
					},
				},
			],
			edges: [
				{ id: 'e1', source: 'trigger-1', target: 'cmd-1', mode: 'pass' },
				{ id: 'e2', source: 'trigger-1', target: 'cmd-2', mode: 'pass' },
				{ id: 'e3', source: 'cmd-1', target: 'agent-1', mode: 'pass' },
				{ id: 'e4', source: 'cmd-2', target: 'agent-2', mode: 'pass' },
				{ id: 'e5', source: 'agent-1', target: 'agent-main', mode: 'pass' },
				{ id: 'e6', source: 'agent-2', target: 'agent-main', mode: 'pass' },
			],
		});
	}

	it('emits one sub per direct command target, no fan_out array', () => {
		const pipeline = makeCommandFanOutPipeline();
		const subs = pipelineToYamlSubscriptions(pipeline);

		// Collect the two branch subs by looking at initial-trigger subs (event=time.scheduled).
		const branchSubs = subs.filter((s) => s.event === 'time.scheduled');
		expect(branchSubs).toHaveLength(2);

		// None of the branch subs should use fan_out — per-branch is the
		// opposite of fan_out; they're independent subs sharing trigger config.
		for (const sub of branchSubs) {
			expect(sub.fan_out).toBeUndefined();
			expect(sub.action).toBe('command');
			expect(sub.schedule_times).toEqual(['07:00']);
		}

		// The two branches carry different command specs for their respective
		// targets (not a single command run twice).
		expect(
			branchSubs.map((s) => (s.command?.mode === 'shell' ? s.command.shell : '')).sort()
		).toEqual(['./script1.sh', './script2.sh']);
	});

	it('chain subs after command branches carry source_sub naming the command sub', () => {
		const pipeline = makeCommandFanOutPipeline();
		const subs = pipelineToYamlSubscriptions(pipeline);

		// Each agent chain sub has source_sub pointing at its upstream command sub.
		// Without source_sub, Cmd1's completion would match the chain sub's
		// source_session AND the chain sub's own completion would re-trigger it.
		const agentChains = subs.filter(
			(s) => s.event === 'agent.completed' && !Array.isArray(s.source_session)
		);
		// Two single-source chains (one per command→agent branch) + main fan-in not in this filter.
		expect(agentChains.length).toBeGreaterThanOrEqual(2);

		for (const sub of agentChains) {
			// source_sub is the name of the command sub that runs before this agent.
			expect(sub.source_sub).toBeDefined();
			expect(typeof sub.source_sub === 'string').toBe(true);
			// And that name matches one of the actual branch sub names.
			expect(['run-script-1', 'run-script-2']).toContain(sub.source_sub as string);
		}
	});

	it('fan-in chain sub lists both upstream agent subs in source_sub', () => {
		const pipeline = makeCommandFanOutPipeline();
		const subs = pipelineToYamlSubscriptions(pipeline);

		// The Main agent aggregates Agent1 + Agent2 via fan-in.
		const fanInSub = subs.find(
			(s) => s.event === 'agent.completed' && Array.isArray(s.source_session)
		);
		expect(fanInSub).toBeDefined();
		expect(Array.isArray(fanInSub!.source_sub)).toBe(true);
		const sourceSubs = fanInSub!.source_sub as string[];
		expect(sourceSubs).toHaveLength(2);
		// The upstream subs are the chain subs that run Agent1 and Agent2 —
		// NOT the command subs. Main fires on agent completion, not command.
		// Every entry must name a sub that actually exists in the output.
		const allNames = new Set(subs.map((s) => s.name));
		for (const name of sourceSubs) {
			expect(allNames.has(name)).toBe(true);
		}
	});

	it('preserves each branch trigger event config so branches arm independently', () => {
		const pipeline = makeCommandFanOutPipeline();
		const subs = pipelineToYamlSubscriptions(pipeline);

		// Both branch subs must carry the schedule config — the engine arms
		// each subscription separately, so an absent schedule_times on the
		// second branch would leave that branch dormant.
		const branchSubs = subs.filter((s) => s.event === 'time.scheduled');
		for (const sub of branchSubs) {
			expect(sub.schedule_times).toEqual(['07:00']);
		}
	});
});

describe('source_sub emission on agent chain subs', () => {
	// Ensures chain subs generated from plain agent chains also carry
	// source_sub so completion filtering is always precise, not only when
	// commands are involved. Prevents regression: if source_sub were only
	// emitted for command branches, a pure Schedule → A → B chain would
	// still self-loop on B's completion matching its own source_session.

	it('single trigger -> agent -> agent chain emits source_sub on the downstream chain', () => {
		const pipeline = makePipeline({
			name: 'Pipeline 1',
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: {
						eventType: 'time.heartbeat',
						label: 'Heartbeat',
						config: { interval_minutes: 5 },
					},
				},
				{
					id: 'agent-a',
					type: 'agent',
					position: { x: 300, y: 0 },
					data: {
						sessionId: 's-a',
						sessionName: 'A',
						toolType: 'claude-code',
						inputPrompt: 'step A',
					},
				},
				{
					id: 'agent-b',
					type: 'agent',
					position: { x: 600, y: 0 },
					data: {
						sessionId: 's-b',
						sessionName: 'B',
						toolType: 'claude-code',
						inputPrompt: 'step B',
					},
				},
			],
			edges: [
				{ id: 'e1', source: 'trigger-1', target: 'agent-a', mode: 'pass' },
				{ id: 'e2', source: 'agent-a', target: 'agent-b', mode: 'pass' },
			],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		expect(subs).toHaveLength(2);
		// Trigger sub runs A directly; no source_sub on initial trigger.
		expect(subs[0].event).toBe('time.heartbeat');
		expect(subs[0].source_sub).toBeUndefined();
		// Chain sub runs B after A completes. source_sub names the trigger
		// sub that actually ran A — so B fires on A's completion only, not
		// on B's own future completion.
		expect(subs[1].event).toBe('agent.completed');
		expect(subs[1].source_session).toBe('A');
		expect(subs[1].source_sub).toBe('Pipeline 1');
	});
});
