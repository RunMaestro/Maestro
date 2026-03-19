/**
 * Integration tests for pipeline chain output variable substitution.
 *
 * Verifies that the full flow works end-to-end:
 * pipelineToYamlSubscriptions → {{CUE_SOURCE_OUTPUT}} injection → substituteTemplateVariables resolution
 */

import { describe, it, expect } from 'vitest';
import { pipelineToYamlSubscriptions } from '../../../../../renderer/components/CuePipelineEditor/utils/pipelineToYaml';
import { substituteTemplateVariables } from '../../../../../shared/templateVariables';
import type { CuePipeline } from '../../../../../shared/cue-pipeline-types';
import type { TemplateContext, TemplateSessionInfo } from '../../../../../shared/templateVariables';

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

const stubSession: TemplateSessionInfo = {
	id: 'test-session',
	name: 'test-agent',
	toolType: 'claude-code',
	cwd: '/tmp/test',
};

describe('pipeline chain output integration', () => {
	it('generated chain prompt resolves {{CUE_SOURCE_OUTPUT}} to actual output', () => {
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
						inputPrompt: 'Build the project',
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
						inputPrompt: 'Review the changes',
					},
				},
			],
			edges: [
				{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' },
				{ id: 'e2', source: 'a1', target: 'a2', mode: 'pass' },
			],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		const chainSub = subs.find((s) => s.event === 'agent.completed');
		expect(chainSub).toBeDefined();
		expect(chainSub!.prompt).toContain('{{CUE_SOURCE_OUTPUT}}');

		// Simulate the engine substituting the template variable
		const context: TemplateContext = {
			session: stubSession,
			cue: {
				sourceOutput: 'Build completed successfully. 42 files compiled.',
				sourceSession: 'builder',
			},
		};
		const resolved = substituteTemplateVariables(chainSub!.prompt!, context);
		expect(resolved).toContain('Build completed successfully. 42 files compiled.');
		expect(resolved).toContain('Review the changes');
		expect(resolved).not.toContain('{{CUE_SOURCE_OUTPUT}}');
	});

	it('preserves user prompt content alongside injected source output', () => {
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
						sessionName: 'reviewer',
						toolType: 'claude-code',
						inputPrompt: 'Review the code changes and suggest improvements',
					},
				},
			],
			edges: [
				{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' },
				{ id: 'e2', source: 'a1', target: 'a2', mode: 'pass' },
			],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		const chainSub = subs.find((s) => s.event === 'agent.completed')!;

		const context: TemplateContext = {
			session: stubSession,
			cue: {
				sourceOutput: 'Diff: +5 -3 lines',
				sourceSession: 'builder',
			},
		};
		const resolved = substituteTemplateVariables(chainSub.prompt!, context);

		// Both the source output AND user instructions should be present
		expect(resolved).toContain('Diff: +5 -3 lines');
		expect(resolved).toContain('Review the code changes and suggest improvements');
	});

	it('handles empty source output gracefully', () => {
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
						inputPrompt: 'Run tests',
					},
				},
			],
			edges: [
				{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' },
				{ id: 'e2', source: 'a1', target: 'a2', mode: 'pass' },
			],
		});

		const subs = pipelineToYamlSubscriptions(pipeline);
		const chainSub = subs.find((s) => s.event === 'agent.completed')!;

		// Simulate empty source output
		const context: TemplateContext = {
			session: stubSession,
			cue: {
				sourceOutput: '',
				sourceSession: 'builder',
			},
		};
		const resolved = substituteTemplateVariables(chainSub.prompt!, context);
		expect(resolved).not.toContain('{{CUE_SOURCE_OUTPUT}}');
		expect(resolved).toContain('Run tests');
	});
});
