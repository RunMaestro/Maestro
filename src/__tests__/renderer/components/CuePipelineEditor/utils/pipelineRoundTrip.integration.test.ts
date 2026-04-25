/**
 * End-to-end round-trip tests across all three Cue fixes:
 *   (1) multi-trigger prompt isolation (Bug 1)
 *   (2) pipeline color persistence (Bug 2)
 *   (3) agent identity stability through rename/deletion (Bug 3)
 *
 * Each scenario exercises a full pipelinesToYaml → YAML parse →
 * subscriptionsToPipelines cycle and asserts the reconstructed state
 * matches the source (modulo fields the user doesn't care about, e.g.
 * auto-layout positions).
 */

import { describe, it, expect } from 'vitest';
import * as yaml from 'js-yaml';

import { pipelinesToYaml } from '../../../../../renderer/components/CuePipelineEditor/utils/pipelineToYaml';
import { subscriptionsToPipelines } from '../../../../../renderer/components/CuePipelineEditor/utils/yamlToPipeline';
import type {
	AgentNodeData,
	CuePipeline,
	ErrorNodeData,
	PipelineEdge,
	PipelineNode,
	TriggerNodeData,
} from '../../../../../shared/cue-pipeline-types';
import type { CueEventType, CueSubscription } from '../../../../../shared/cue/contracts';

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function trigger(id: string, eventType: CueEventType, y = 0): PipelineNode {
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

function agent(id: string, sessionId: string, sessionName: string, y = 0): PipelineNode {
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

function edge(
	id: string,
	source: string,
	target: string,
	overrides: Partial<PipelineEdge> = {}
): PipelineEdge {
	return { id, source, target, mode: 'pass', ...overrides };
}

function pipeline(
	id: string,
	name: string,
	color: string,
	nodes: PipelineNode[],
	edges: PipelineEdge[]
): CuePipeline {
	return { id, name, color, nodes, edges };
}

/**
 * Serializes pipelines to YAML, parses back, merges prompt files inline
 * (since pipelineToYaml emits prompts as external files), and hands the
 * resulting CueSubscription[] to subscriptionsToPipelines.
 *
 * This mirrors what happens across main/renderer at runtime where the
 * normalizer resolves `prompt_file` references into inline `prompt`
 * strings before the renderer sees them.
 */
function roundTrip(
	pipelines: CuePipeline[],
	sessions: Array<{ id: string; name: string; toolType: string }>
): CuePipeline[] {
	const { yaml: yamlStr, promptFiles } = pipelinesToYaml(pipelines);
	const parsed = yaml.load(yamlStr) as {
		subscriptions: Array<Record<string, unknown>>;
	};
	const subs: CueSubscription[] = parsed.subscriptions.map((raw) => {
		const promptFile = typeof raw.prompt_file === 'string' ? raw.prompt_file : undefined;
		const prompt = promptFile ? (promptFiles.get(promptFile) ?? '') : '';
		// Strip prompt_file fields to mirror the normalizer's inline-resolution step.
		const { prompt_file: _pf, output_prompt_file: _opf, ...rest } = raw;
		return {
			...(rest as Partial<CueSubscription>),
			enabled: rest.enabled !== false,
			prompt,
		} as CueSubscription;
	});
	return subscriptionsToPipelines(
		subs,
		sessions.map((s) => ({ ...s, toolType: 'claude-code' as const }))
	);
}

// ─── Scenario 1: multi-trigger prompt isolation ──────────────────────────────

describe('round-trip: multi-trigger prompt isolation', () => {
	it('two triggers → one agent with distinct edge prompts round-trip losslessly', () => {
		const t1 = trigger('t1', 'github.issue', 0);
		const t2 = trigger('t2', 'github.pull_request', 100);
		const a1 = agent('a1', 'sess-a', 'Alpha', 50);

		const pipelines: CuePipeline[] = [
			pipeline(
				'pipe-1',
				'MultiTrigger',
				'#06b6d4',
				[t1, t2, a1],
				[
					edge('e1', 't1', 'a1', { prompt: 'handle issue number {{CUE_GH_NUMBER}}' }),
					edge('e2', 't2', 'a1', { prompt: 'review PR {{CUE_GH_URL}}' }),
				]
			),
		];

		const sessions = [{ id: 'sess-a', name: 'Alpha', toolType: 'claude-code' }];
		const [reconstructed] = roundTrip(pipelines, sessions);

		const agentNode = reconstructed.nodes.find((n) => n.type === 'agent')!;
		const incomingEdges = reconstructed.edges.filter((e) => e.target === agentNode.id);
		expect(incomingEdges).toHaveLength(2);

		// Each edge kept its own prompt — no leakage.
		const prompts = incomingEdges.map((e) => e.prompt).sort();
		expect(prompts).toEqual(['handle issue number {{CUE_GH_NUMBER}}', 'review PR {{CUE_GH_URL}}']);
	});
});

// ─── Scenario 2: pipeline color persistence ──────────────────────────────────

describe('round-trip: pipeline color persistence', () => {
	it('three pipelines with distinct colors survive double round-trip', () => {
		const pipelines: CuePipeline[] = [
			pipeline(
				'p1',
				'alpha',
				'#ef4444',
				[trigger('t1', 'time.heartbeat'), agent('a1', 'sess-1', 'Alpha')],
				[edge('e1', 't1', 'a1')]
			),
			pipeline(
				'p2',
				'bravo',
				'#8b5cf6',
				[trigger('t2', 'time.heartbeat'), agent('a2', 'sess-2', 'Bravo')],
				[edge('e2', 't2', 'a2')]
			),
			pipeline(
				'p3',
				'charlie',
				'#f59e0b',
				[trigger('t3', 'time.heartbeat'), agent('a3', 'sess-3', 'Charlie')],
				[edge('e3', 't3', 'a3')]
			),
		];
		const sessions = [
			{ id: 'sess-1', name: 'Alpha', toolType: 'claude-code' },
			{ id: 'sess-2', name: 'Bravo', toolType: 'claude-code' },
			{ id: 'sess-3', name: 'Charlie', toolType: 'claude-code' },
		];

		// Pass 1
		const r1 = roundTrip(pipelines, sessions);
		const colorsByName1 = Object.fromEntries(r1.map((p) => [p.name, p.color]));
		expect(colorsByName1.alpha).toBe('#ef4444');
		expect(colorsByName1.bravo).toBe('#8b5cf6');
		expect(colorsByName1.charlie).toBe('#f59e0b');

		// Pass 2 — simulates "save, reload, save again, reload"
		const r2 = roundTrip(r1, sessions);
		const colorsByName2 = Object.fromEntries(r2.map((p) => [p.name, p.color]));
		expect(colorsByName2).toEqual(colorsByName1);
	});
});

// ─── Scenario 3: agent identity (rename / deletion) ──────────────────────────

describe('round-trip: agent identity stability', () => {
	it('chain edge survives an upstream agent rename via source_session_ids', () => {
		const t1 = trigger('t1', 'time.heartbeat');
		const a1 = agent('a1', 'sess-up', 'OriginalName');
		const a2 = agent('a2', 'sess-down', 'Downstream', 100);

		const pipelines: CuePipeline[] = [
			pipeline(
				'p1',
				'chain',
				'#22c55e',
				[t1, a1, a2],
				[edge('e1', 't1', 'a1'), edge('e2', 'a1', 'a2')]
			),
		];

		// Serialize with original session names.
		const { yaml: yamlStr, promptFiles } = pipelinesToYaml(pipelines);
		const parsed = yaml.load(yamlStr) as {
			subscriptions: Array<Record<string, unknown>>;
		};
		const subs: CueSubscription[] = parsed.subscriptions.map((raw) => {
			const pf = typeof raw.prompt_file === 'string' ? raw.prompt_file : undefined;
			const prompt = pf ? (promptFiles.get(pf) ?? '') : '';
			const { prompt_file: _pf, output_prompt_file: _opf, ...rest } = raw;
			return { ...(rest as Partial<CueSubscription>), enabled: true, prompt } as CueSubscription;
		});

		// Now the upstream agent is renamed.
		const postRenameSessions = [
			{ id: 'sess-up', name: 'RenamedAgent', toolType: 'claude-code' as const },
			{ id: 'sess-down', name: 'Downstream', toolType: 'claude-code' as const },
		];
		const [reconstructed] = subscriptionsToPipelines(subs, postRenameSessions);

		// Chain edge should still resolve and the reconstructed agent reflects the new name.
		const agentNames = reconstructed.nodes
			.filter((n) => n.type === 'agent')
			.map((n) => (n.data as AgentNodeData).sessionName);
		expect(agentNames).toContain('RenamedAgent');
		expect(agentNames).toContain('Downstream');
		// No error nodes — ID resolution succeeded.
		const errors = reconstructed.nodes.filter((n) => n.type === 'error');
		expect(errors).toHaveLength(0);
	});

	it('emits an error node when the target agent has been deleted', () => {
		const t1 = trigger('t1', 'time.heartbeat');
		const a1 = agent('a1', 'sess-gone', 'Goner');

		const pipelines: CuePipeline[] = [
			pipeline('p1', 'deleted', '#ef4444', [t1, a1], [edge('e1', 't1', 'a1')]),
		];

		const { yaml: yamlStr, promptFiles } = pipelinesToYaml(pipelines);
		const parsed = yaml.load(yamlStr) as {
			subscriptions: Array<Record<string, unknown>>;
		};
		const subs: CueSubscription[] = parsed.subscriptions.map((raw) => {
			const pf = typeof raw.prompt_file === 'string' ? raw.prompt_file : undefined;
			const prompt = pf ? (promptFiles.get(pf) ?? '') : '';
			const { prompt_file: _pf, ...rest } = raw;
			return { ...(rest as Partial<CueSubscription>), enabled: true, prompt } as CueSubscription;
		});

		// The agent has been deleted — no matching session.
		const emptySessions: Array<{ id: string; name: string; toolType: 'claude-code' }> = [];
		const [reconstructed] = subscriptionsToPipelines(subs, emptySessions);

		const errors = reconstructed.nodes.filter((n) => n.type === 'error');
		expect(errors.length).toBeGreaterThan(0);
		const err = errors[0].data as ErrorNodeData;
		expect(err.reason).toBe('missing-target');
		expect(err.unresolvedId).toBe('sess-gone');
	});
});

// ─── Scenario 4: iteration-order invariance ─────────────────────────────────

describe('round-trip: iteration-order invariance', () => {
	it('shuffling subscription order produces an isomorphic graph', () => {
		const pipelines: CuePipeline[] = [
			pipeline(
				'p1',
				'chain',
				'#06b6d4',
				[
					trigger('t1', 'time.heartbeat'),
					agent('a1', 'sess-a', 'A'),
					agent('a2', 'sess-b', 'B'),
					agent('a3', 'sess-c', 'C'),
				],
				[edge('e1', 't1', 'a1'), edge('e2', 'a1', 'a2'), edge('e3', 'a2', 'a3')]
			),
		];
		const sessions = [
			{ id: 'sess-a', name: 'A', toolType: 'claude-code' },
			{ id: 'sess-b', name: 'B', toolType: 'claude-code' },
			{ id: 'sess-c', name: 'C', toolType: 'claude-code' },
		];

		const { yaml: yamlStr, promptFiles } = pipelinesToYaml(pipelines);
		const parsed = yaml.load(yamlStr) as {
			subscriptions: Array<Record<string, unknown>>;
		};
		const buildSubs = (order: number[]) =>
			order
				.map((i) => parsed.subscriptions[i])
				.map((raw) => {
					const pf = typeof raw.prompt_file === 'string' ? raw.prompt_file : undefined;
					const prompt = pf ? (promptFiles.get(pf) ?? '') : '';
					const { prompt_file: _pf, ...rest } = raw;
					return {
						...(rest as Partial<CueSubscription>),
						enabled: true,
						prompt,
					} as CueSubscription;
				});

		const inOrder = subscriptionsToPipelines(
			buildSubs([0, 1, 2]),
			sessions.map((s) => ({ ...s, toolType: 'claude-code' as const }))
		);
		const reversed = subscriptionsToPipelines(
			buildSubs([2, 1, 0]),
			sessions.map((s) => ({ ...s, toolType: 'claude-code' as const }))
		);
		const shuffled = subscriptionsToPipelines(
			buildSubs([1, 2, 0]),
			sessions.map((s) => ({ ...s, toolType: 'claude-code' as const }))
		);

		const summarize = (pipe: CuePipeline[]): string[] =>
			pipe[0].nodes
				.map((n) =>
					n.type === 'agent' ? `agent:${(n.data as AgentNodeData).sessionName}` : n.type
				)
				.sort();

		expect(summarize(inOrder)).toEqual(summarize(reversed));
		expect(summarize(inOrder)).toEqual(summarize(shuffled));
		expect(inOrder[0].edges.length).toBe(reversed[0].edges.length);
	});
});
