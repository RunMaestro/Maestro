import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { subscriptionsToPipelines } from '../../../../../renderer/components/CuePipelineEditor/utils/yamlToPipeline';
import type { CueSubscription } from '../../../../../shared/cue/contracts';
import * as yaml from 'js-yaml';
import { pipelinesToYaml } from '../../../../../renderer/components/CuePipelineEditor/utils/pipelineToYaml';
import type { CuePipeline } from '../../../../../shared/cue-pipeline-types';
import type { PipelineNode } from '../../../../../shared/cue-pipeline-types';
import type { AgentNodeData } from '../../../../../shared/cue-pipeline-types';
import type { TriggerNodeData } from '../../../../../shared/cue-pipeline-types';
import type { CueEventType } from '../../../../../shared/cue/contracts';
import { pipelineToYamlSubscriptions } from '../../../../../renderer/components/CuePipelineEditor/utils/pipelineToYaml';
import { substituteTemplateVariables } from '../../../../../shared/templateVariables';
import type { TemplateContext } from '../../../../../shared/templateVariables';
import type { TemplateSessionInfo } from '../../../../../shared/templateVariables';
__maestroMicrobenchDescribe('yamlToPipeline.pipelineName', () => {
	function makeSessions(entries: Array<[string, string]>) {
		return entries.map(([id, name]) => ({ id, name, toolType: 'claude-code' as const }));
	}

	describe('pipeline_name-based grouping', () => {
		it('groups subscriptions by explicit pipeline_name even when subscription names diverge', () => {
			// User edited the trigger subscription's `name` from "Pipeline 1"
			// to "Morning Run" but left the chain subs untouched. With
			// suffix-based grouping this used to split the pipeline into two
			// (trigger-only and chain-only) and break rendering.
			const subs: CueSubscription[] = [
				{
					name: 'Morning Run',
					event: 'time.heartbeat',
					enabled: true,
					prompt: '',
					interval_minutes: 5,
					agent_id: 'sess-a',
					pipeline_name: 'Pipeline 1',
				},
				{
					name: 'Pipeline 1-chain-1',
					event: 'agent.completed',
					enabled: true,
					prompt: '',
					source_session: ['A'],
					source_session_ids: ['sess-a'],
					agent_id: 'sess-b',
					pipeline_name: 'Pipeline 1',
				},
				{
					name: 'Pipeline 1-chain-2',
					event: 'agent.completed',
					enabled: true,
					prompt: '',
					source_session: ['B'],
					source_session_ids: ['sess-b'],
					agent_id: 'sess-c',
					pipeline_name: 'Pipeline 1',
				},
			];
			const sessions = makeSessions([
				['sess-a', 'A'],
				['sess-b', 'B'],
				['sess-c', 'C'],
			]);

			const pipelines = subscriptionsToPipelines(subs, sessions);
			expect(pipelines).toHaveLength(1);
			expect(pipelines[0].name).toBe('Pipeline 1');
			const agentNames = pipelines[0].nodes
				.filter((n) => n.type === 'agent')
				.map((n) => (n.data as { sessionName: string }).sessionName);
			expect(agentNames).toEqual(expect.arrayContaining(['A', 'B', 'C']));
		});

		it('groups subscriptions by pipeline_name when `name`s collide across pipelines', () => {
			// Two pipelines where every subscription is named "Work" - would be
			// impossible to disambiguate via suffix convention. pipeline_name
			// makes this trivial.
			const subs: CueSubscription[] = [
				{
					name: 'Work',
					event: 'time.heartbeat',
					enabled: true,
					prompt: '',
					interval_minutes: 5,
					agent_id: 'sess-a',
					pipeline_name: 'Alpha',
				},
				{
					name: 'Work',
					event: 'time.heartbeat',
					enabled: true,
					prompt: '',
					interval_minutes: 5,
					agent_id: 'sess-b',
					pipeline_name: 'Bravo',
				},
			];
			const sessions = makeSessions([
				['sess-a', 'A'],
				['sess-b', 'B'],
			]);

			const pipelines = subscriptionsToPipelines(subs, sessions);
			const names = pipelines.map((p) => p.name).sort();
			expect(names).toEqual(['Alpha', 'Bravo']);
		});

		it('falls back to suffix-based grouping for legacy YAML (no pipeline_name)', () => {
			const subs: CueSubscription[] = [
				{
					name: 'legacy',
					event: 'time.heartbeat',
					enabled: true,
					prompt: '',
					interval_minutes: 5,
					agent_id: 'sess-a',
				},
				{
					name: 'legacy-chain-1',
					event: 'agent.completed',
					enabled: true,
					prompt: '',
					source_session: ['A'],
					agent_id: 'sess-b',
				},
			];
			const sessions = makeSessions([
				['sess-a', 'A'],
				['sess-b', 'B'],
			]);

			const pipelines = subscriptionsToPipelines(subs, sessions);
			expect(pipelines).toHaveLength(1);
			expect(pipelines[0].name).toBe('legacy');
		});
	});
});
__maestroMicrobenchDescribe('yamlToPipeline.chainIds', () => {
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
			// to the new agent - hiding the fact that the original reference is
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
			// NOT be wired into this pipeline - its identity is different from the
			// deleted reference. It may still appear as a node because it owns its
			// own trigger sub, but it must not be the resolved source of the
			// chain edge.
			const errorNodes = pipeline.nodes.filter((n) => n.type === 'error');
			expect(errorNodes.length).toBeGreaterThanOrEqual(1);
			const sourceError = errorNodes.find(
				(n) => (n.data as { reason: string }).reason === 'missing-source'
			);
			expect(sourceError).toBeDefined();
			expect((sourceError!.data as { unresolvedId?: string }).unresolvedId).toBe(
				'sess-deleted-uuid'
			);
			// Downstream agent still wired; Current still present (owns trigger sub);
			// no silent adoption of the StillPresent agent as the chain source.
			expect(agentNames).toContain('Downstream');

			// Topology guard: checking node presence alone isn't enough - a buggy
			// resolver could still render the error node AND wire the Downstream
			// chain edge to the live StillPresent agent. Walk the downstream
			// agent's incoming edges and verify none of them originates from the
			// live-sessionName agent; the only valid source for the chain-1 sub
			// is the error node.
			const downstreamNode = pipeline.nodes.find(
				(n) =>
					n.type === 'agent' && (n.data as { sessionName: string }).sessionName === 'Downstream'
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
});
__maestroMicrobenchDescribe('pipelineColor.roundTrip', () => {
	function makeTrigger(id: string, eventType: CueEventType, y = 0): PipelineNode {
		return {
			id,
			type: 'trigger',
			position: { x: 0, y },
			data: {
				eventType,
				label: 'Trigger',
				config: eventType === 'time.heartbeat' ? { interval_minutes: 5 } : {},
			} as TriggerNodeData,
		};
	}

	function makeAgent(id: string, sessionId: string, sessionName: string, y = 0): PipelineNode {
		return {
			id,
			type: 'agent',
			position: { x: 200, y },
			data: {
				sessionId,
				sessionName,
				toolType: 'claude-code',
			} as AgentNodeData,
		};
	}

	function makePipeline(name: string, color: string, agents: Array<[string, string]>): CuePipeline {
		const nodes: PipelineNode[] = [];
		const edges: CuePipeline['edges'] = [];
		const triggerId = `trigger-${name}`;
		nodes.push(makeTrigger(triggerId, 'time.heartbeat'));
		agents.forEach(([sessionId, sessionName], i) => {
			const agentId = `agent-${name}-${i}`;
			nodes.push(makeAgent(agentId, sessionId, sessionName, i * 100));
			edges.push({ id: `edge-${name}-${i}`, source: triggerId, target: agentId, mode: 'pass' });
		});
		return { id: `pipeline-${name}`, name, color, nodes, edges };
	}

	describe('pipeline color persistence', () => {
		it('emits pipeline_color on every subscription', () => {
			const pipelines: CuePipeline[] = [
				makePipeline('alpha', '#ef4444', [['sess-1', 'Alpha Agent']]),
				makePipeline('bravo', '#8b5cf6', [['sess-2', 'Bravo Agent']]),
			];
			const { yaml: yamlStr } = pipelinesToYaml(pipelines);
			const parsed = yaml.load(yamlStr) as { subscriptions: Array<Record<string, unknown>> };

			const alphaSubs = parsed.subscriptions.filter((s) => String(s.name).startsWith('alpha'));
			const bravoSubs = parsed.subscriptions.filter((s) => String(s.name).startsWith('bravo'));

			expect(alphaSubs.length).toBeGreaterThan(0);
			expect(bravoSubs.length).toBeGreaterThan(0);
			for (const s of alphaSubs) expect(s.pipeline_color).toBe('#ef4444');
			for (const s of bravoSubs) expect(s.pipeline_color).toBe('#8b5cf6');
		});

		it('round-trips pipeline_color through pipelinesToYaml → subscriptionsToPipelines', () => {
			const pipelines: CuePipeline[] = [
				makePipeline('alpha', '#ef4444', [['sess-1', 'Alpha']]),
				makePipeline('bravo', '#8b5cf6', [['sess-2', 'Bravo']]),
				makePipeline('charlie', '#f59e0b', [['sess-3', 'Charlie']]),
			];

			const subs = pipelinesForRoundTrip(pipelines);
			const sessions = [
				{ id: 'sess-1', name: 'Alpha', toolType: 'claude-code' as const },
				{ id: 'sess-2', name: 'Bravo', toolType: 'claude-code' as const },
				{ id: 'sess-3', name: 'Charlie', toolType: 'claude-code' as const },
			];

			const reconstructed = subscriptionsToPipelines(subs, sessions);
			expect(reconstructed).toHaveLength(3);
			const byName = Object.fromEntries(reconstructed.map((p) => [p.name, p.color]));
			expect(byName.alpha).toBe('#ef4444');
			expect(byName.bravo).toBe('#8b5cf6');
			expect(byName.charlie).toBe('#f59e0b');
		});

		it('falls back to palette derivation when pipeline_color is absent (legacy YAML)', () => {
			const subs: CueSubscription[] = [
				{
					name: 'legacy',
					event: 'time.heartbeat',
					enabled: true,
					prompt: '',
					interval_minutes: 5,
					agent_id: 'sess-x',
					// pipeline_color deliberately omitted
				},
			];
			const sessions = [{ id: 'sess-x', name: 'X', toolType: 'claude-code' as const }];
			const reconstructed = subscriptionsToPipelines(subs, sessions);

			expect(reconstructed).toHaveLength(1);
			// Palette fallback returns a valid hex color, not undefined/empty.
			expect(reconstructed[0].color).toMatch(/^#[0-9a-fA-F]{6}$/);
		});

		it('ignores malformed pipeline_color values and falls back to palette', () => {
			const subs: CueSubscription[] = [
				{
					name: 'malformed',
					event: 'time.heartbeat',
					enabled: true,
					prompt: '',
					interval_minutes: 5,
					agent_id: 'sess-x',
					pipeline_color: 'not-a-hex-color',
				},
			];
			const sessions = [{ id: 'sess-x', name: 'X', toolType: 'claude-code' as const }];
			const reconstructed = subscriptionsToPipelines(subs, sessions);

			expect(reconstructed).toHaveLength(1);
			expect(reconstructed[0].color).toMatch(/^#[0-9a-fA-F]{6}$/);
			expect(reconstructed[0].color).not.toBe('not-a-hex-color');
		});

		it('colors do not drift when pipelines are loaded twice in a row (tab-switch simulation)', () => {
			const pipelines: CuePipeline[] = [
				makePipeline('alpha', '#ef4444', [['sess-1', 'Alpha']]),
				makePipeline('bravo', '#8b5cf6', [['sess-2', 'Bravo']]),
			];
			const subs = pipelinesForRoundTrip(pipelines);
			const sessions = [
				{ id: 'sess-1', name: 'Alpha', toolType: 'claude-code' as const },
				{ id: 'sess-2', name: 'Bravo', toolType: 'claude-code' as const },
			];

			const first = subscriptionsToPipelines(subs, sessions);
			const second = subscriptionsToPipelines(subs, sessions);

			const firstColors = Object.fromEntries(first.map((p) => [p.name, p.color]));
			const secondColors = Object.fromEntries(second.map((p) => [p.name, p.color]));
			expect(firstColors).toEqual(secondColors);
		});
	});

	// Helper: take pipelines → YAML → parse → extract subscriptions as CueSubscription[].
	function pipelinesForRoundTrip(pipelines: CuePipeline[]): CueSubscription[] {
		const { yaml: yamlStr, promptFiles } = pipelinesToYaml(pipelines);
		const parsed = yaml.load(yamlStr) as { subscriptions: Array<Record<string, unknown>> };
		return parsed.subscriptions.map((raw) => {
			const promptFile = typeof raw.prompt_file === 'string' ? raw.prompt_file : undefined;
			const prompt = promptFile ? (promptFiles.get(promptFile) ?? '') : '';
			return {
				...(raw as Partial<CueSubscription>),
				enabled: raw.enabled !== false,
				prompt,
			} as CueSubscription;
		});
	}
});
__maestroMicrobenchDescribe('pipelineChainIntegration', () => {
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
});
