/**
 * Round-trip integration tests for pipeline shapes that have *historically*
 * lost data when serialized to YAML and reloaded. Complements
 * `pipelineRoundTrip.integration.test.ts` (which covers prompt isolation,
 * pipeline color, agent identity, and iteration order) by guarding the
 * shape-specific failure modes that produced repeated bugfix commits over
 * the last quarter:
 *
 *   - Trigger fan-out (1 trigger → N parallel agents) must preserve every
 *     downstream agent and the per-target prompt distribution.
 *     [977034e42] preserve target_node_key + fan_out_node_keys
 *
 *   - Multi-agent linear chains must preserve depth and the per-agent
 *     prompts (which round-trip as agent.inputPrompt rather than edge.prompt
 *     because chain prompts are emitted as the chain sub's `prompt` field).
 *     [705f3763a] preserve node positions and prevent pipeline-vanishes-after-save
 *     [dc853069e] resolve chain upstreams via source_sub on load
 *
 *   - Trigger event configs (time.scheduled days+times, file.changed
 *     watch+filter, github.pull_request repo+poll_minutes,
 *     time.heartbeat interval_minutes) must round-trip exactly.
 *
 *   - Double round-trip is structurally idempotent — guards drift bugs
 *     where save→reload→save mutates fields.
 *
 * Test invariants:
 *   - Visual-only fields (positions, ids, edge ids) are intentionally NOT
 *     compared. Auto-layout regenerates positions; ids regenerate on load.
 *   - Per-edge `mode` (autorun/debate) is INTENTIONALLY NOT TESTED here:
 *     edge modes are persisted as YAML comments by `pipelineToYaml`, and
 *     `yaml.load()` strips comments — so they are recovered separately
 *     from the editor-side `pipelineLayout.json` sidecar, not from the
 *     YAML body. A round-trip test through `yaml.load()` would correctly
 *     show "lost" and create a misleading assertion. See pipelineToYaml.ts
 *     `getEdgeModeComment()` for the source-of-truth on this design.
 */

import { describe, it, expect } from 'vitest';
import * as yaml from 'js-yaml';

import { pipelinesToYaml } from '../../../../../renderer/components/CuePipelineEditor/utils/pipelineToYaml';
import { subscriptionsToPipelines } from '../../../../../renderer/components/CuePipelineEditor/utils/yamlToPipeline';
import type {
	AgentNodeData,
	CuePipeline,
	PipelineEdge,
	PipelineNode,
	TriggerNodeData,
} from '../../../../../shared/cue-pipeline-types';
import type { CueEventType, CueSubscription } from '../../../../../shared/cue/contracts';

// ─── Fixture helpers ─────────────────────────────────────────────────────────

interface PipelineSession {
	id: string;
	name: string;
	toolType: 'claude-code';
}

function trigger(
	id: string,
	eventType: CueEventType,
	config: TriggerNodeData['config'] = {}
): PipelineNode {
	return {
		id,
		type: 'trigger',
		position: { x: 0, y: 0 },
		data: { eventType, label: 'Trigger', config } as TriggerNodeData,
	};
}

function agent(id: string, sessionId: string, sessionName: string): PipelineNode {
	return {
		id,
		type: 'agent',
		position: { x: 200, y: 0 },
		data: { sessionId, sessionName, toolType: 'claude-code' } as AgentNodeData,
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
	name: string,
	color: string,
	nodes: PipelineNode[],
	edges: PipelineEdge[]
): CuePipeline {
	return { id: name.toLowerCase(), name, color, nodes, edges };
}

/**
 * Drives the same pipelinesToYaml → YAML parse → subscriptionsToPipelines
 * cycle that the runtime uses. Mirrors the normalizer's prompt-file inlining
 * so tests don't need to know about external prompt files. Handles BOTH
 * `prompt_file` (single) and `fan_out_prompt_files` (array) — both shapes
 * are emitted by `pipelineToYaml` depending on whether the trigger feeds
 * one target or fans out to many.
 */
function roundTrip(pipelines: CuePipeline[], sessions: PipelineSession[]): CuePipeline[] {
	const { yaml: yamlStr, promptFiles } = pipelinesToYaml(pipelines);
	const parsed = yaml.load(yamlStr) as {
		subscriptions: Array<Record<string, unknown>>;
	};
	const subs: CueSubscription[] = parsed.subscriptions.map((raw) => {
		// Single prompt_file: resolve to inline prompt (mirrors normalizer).
		const promptFile = typeof raw.prompt_file === 'string' ? raw.prompt_file : undefined;
		const prompt = promptFile ? (promptFiles.get(promptFile) ?? '') : '';

		// Fan-out prompts: each slot's prompt_file becomes the inline string.
		const fanOutPromptFilesRaw = Array.isArray(raw.fan_out_prompt_files)
			? (raw.fan_out_prompt_files as string[])
			: undefined;
		const fanOutPrompts = fanOutPromptFilesRaw?.map((p) => promptFiles.get(p) ?? '');

		const { prompt_file: _pf, output_prompt_file: _opf, ...rest } = raw;
		return {
			...(rest as Partial<CueSubscription>),
			enabled: rest.enabled !== false,
			prompt,
			...(fanOutPrompts ? { fan_out_prompts: fanOutPrompts } : {}),
		} as CueSubscription;
	});
	return subscriptionsToPipelines(subs, sessions);
}

// ─── Shape: trigger fan-out (1 trigger → N agents) ───────────────────────────

describe('round-trip: trigger fan-out preserves all downstream agents', () => {
	it('one trigger fanning out to three distinct agents reconstructs all three', () => {
		const t1 = trigger('t1', 'time.heartbeat', { interval_minutes: 5 });
		const a1 = agent('a1', 'sess-a', 'Alpha');
		const a2 = agent('a2', 'sess-b', 'Bravo');
		const a3 = agent('a3', 'sess-c', 'Charlie');

		const pipelines = [
			pipeline(
				'FanOut',
				'#06b6d4',
				[t1, a1, a2, a3],
				[
					edge('e1', 't1', 'a1', { prompt: 'task alpha' }),
					edge('e2', 't1', 'a2', { prompt: 'task bravo' }),
					edge('e3', 't1', 'a3', { prompt: 'task charlie' }),
				]
			),
		];
		const sessions: PipelineSession[] = [
			{ id: 'sess-a', name: 'Alpha', toolType: 'claude-code' },
			{ id: 'sess-b', name: 'Bravo', toolType: 'claude-code' },
			{ id: 'sess-c', name: 'Charlie', toolType: 'claude-code' },
		];

		const [reconstructed] = roundTrip(pipelines, sessions);

		// All three agents survived (the fan-out target list was the bug surface).
		const agentSessionIds = reconstructed.nodes
			.filter((n) => n.type === 'agent')
			.map((n) => (n.data as AgentNodeData).sessionId)
			.sort();
		expect(agentSessionIds).toEqual(['sess-a', 'sess-b', 'sess-c']);

		// Three trigger→agent edges remain (the topology survived).
		const triggerNode = reconstructed.nodes.find((n) => n.type === 'trigger')!;
		const outgoing = reconstructed.edges.filter((e) => e.source === triggerNode.id);
		expect(outgoing).toHaveLength(3);
	});

	it('fan-out distributes per-target prompts via fan_out_prompts', () => {
		// `pipelineToYaml` emits per-target prompts as `fan_out_prompt_files`,
		// the normalizer inlines them as `fan_out_prompts[i]`, and the
		// renderer threads them onto the trigger→agent edge. Without this
		// distribution intact, all three agents would receive the same
		// fallback `prompt` (currently '') instead of their own task strings.
		const t1 = trigger('t1', 'time.heartbeat', { interval_minutes: 5 });
		const a1 = agent('a1', 'sess-a', 'Alpha');
		const a2 = agent('a2', 'sess-b', 'Bravo');

		const pipelines = [
			pipeline(
				'FanOut',
				'#06b6d4',
				[t1, a1, a2],
				[
					edge('e1', 't1', 'a1', { prompt: 'work for alpha' }),
					edge('e2', 't1', 'a2', { prompt: 'work for bravo' }),
				]
			),
		];
		const sessions: PipelineSession[] = [
			{ id: 'sess-a', name: 'Alpha', toolType: 'claude-code' },
			{ id: 'sess-b', name: 'Bravo', toolType: 'claude-code' },
		];

		const [reconstructed] = roundTrip(pipelines, sessions);
		const promptsByAgentName: Record<string, string | undefined> = {};
		for (const e of reconstructed.edges) {
			const target = reconstructed.nodes.find((n) => n.id === e.target);
			if (target?.type !== 'agent') continue;
			promptsByAgentName[(target.data as AgentNodeData).sessionName] = e.prompt;
		}
		expect(promptsByAgentName).toEqual({
			Alpha: 'work for alpha',
			Bravo: 'work for bravo',
		});
	});

	it('fan-out to two visual nodes pointing at the SAME sessionId stays as two nodes', () => {
		// Regression for 977034e42: two visual instances of the same agent
		// in a fan-out used to merge into a single node on reload because
		// the loader keyed by sessionId. The fix added stable nodeKeys
		// persisted as `target_node_key` / `fan_out_node_keys`.
		const t1 = trigger('t1', 'time.heartbeat', { interval_minutes: 5 });
		const a1: PipelineNode = {
			...agent('a1', 'sess-a', 'Alpha'),
			data: { ...(agent('a1', 'sess-a', 'Alpha').data as AgentNodeData), nodeKey: 'key-1' },
		};
		const a2: PipelineNode = {
			...agent('a2', 'sess-a', 'Alpha'),
			data: { ...(agent('a2', 'sess-a', 'Alpha').data as AgentNodeData), nodeKey: 'key-2' },
		};

		const pipelines = [
			pipeline(
				'DupFanOut',
				'#06b6d4',
				[t1, a1, a2],
				[
					edge('e1', 't1', 'a1', { prompt: 'instance 1 work' }),
					edge('e2', 't1', 'a2', { prompt: 'instance 2 work' }),
				]
			),
		];
		const sessions: PipelineSession[] = [{ id: 'sess-a', name: 'Alpha', toolType: 'claude-code' }];

		const [reconstructed] = roundTrip(pipelines, sessions);

		// Two distinct agent nodes, both pointing at sess-a — NOT merged.
		const agents = reconstructed.nodes.filter((n) => n.type === 'agent');
		expect(agents).toHaveLength(2);
		expect(agents.every((n) => (n.data as AgentNodeData).sessionId === 'sess-a')).toBe(true);
	});
});

// ─── Shape: multi-agent linear chain ─────────────────────────────────────────

describe('round-trip: multi-agent linear chain', () => {
	it('a four-deep chain preserves every node and the chain topology', () => {
		const t1 = trigger('t1', 'time.heartbeat', { interval_minutes: 5 });
		const a1 = agent('a1', 'sess-1', 'A1');
		const a2 = agent('a2', 'sess-2', 'A2');
		const a3 = agent('a3', 'sess-3', 'A3');
		const a4 = agent('a4', 'sess-4', 'A4');

		const pipelines = [
			pipeline(
				'Chain',
				'#06b6d4',
				[t1, a1, a2, a3, a4],
				[
					edge('e1', 't1', 'a1', { prompt: 'first' }),
					edge('e2', 'a1', 'a2', { prompt: 'second' }),
					edge('e3', 'a2', 'a3', { prompt: 'third' }),
					edge('e4', 'a3', 'a4', { prompt: 'fourth' }),
				]
			),
		];
		const sessions: PipelineSession[] = [
			{ id: 'sess-1', name: 'A1', toolType: 'claude-code' },
			{ id: 'sess-2', name: 'A2', toolType: 'claude-code' },
			{ id: 'sess-3', name: 'A3', toolType: 'claude-code' },
			{ id: 'sess-4', name: 'A4', toolType: 'claude-code' },
		];

		const [reconstructed] = roundTrip(pipelines, sessions);

		expect(reconstructed.nodes.filter((n) => n.type === 'agent')).toHaveLength(4);
		expect(reconstructed.nodes.filter((n) => n.type === 'trigger')).toHaveLength(1);

		// Walk the topology by following edges from the trigger and assert the
		// agent visitation order. Edge prompts on chain edges intentionally
		// land on the target agent's `inputPrompt` (chain subs emit the prompt
		// at the SUB level, not the edge level — see yamlToPipeline.ts:1030),
		// so we assert the per-agent sequence rather than per-edge.
		const triggerNode = reconstructed.nodes.find((n) => n.type === 'trigger')!;
		const visitedAgents: string[] = [];
		let current: PipelineNode | undefined = triggerNode;
		const seen = new Set<string>();
		while (current && !seen.has(current.id)) {
			seen.add(current.id);
			const next = reconstructed.edges.find((e) => e.source === current!.id);
			if (!next) break;
			const target = reconstructed.nodes.find((n) => n.id === next.target);
			if (!target) break;
			if (target.type === 'agent') {
				visitedAgents.push((target.data as AgentNodeData).sessionId);
			}
			current = target;
		}
		expect(visitedAgents).toEqual(['sess-1', 'sess-2', 'sess-3', 'sess-4']);
	});

	it('chain prompts on agent.inputPrompt round-trip onto the same field', () => {
		// IMPORTANT: chain prompts in this model live on the TARGET agent's
		// `inputPrompt` field, NOT on the edge between agents. `pipelineToYaml`
		// only reads `edge.prompt` for trigger→agent edges (fan-out path);
		// for chain (agent→agent) edges, it reads the target's `inputPrompt`.
		// Setting `edge.prompt` on a chain edge silently drops the value.
		// This test guards the supported path: input prompts on agent nodes.
		const t1 = trigger('t1', 'time.heartbeat', { interval_minutes: 5 });
		const a1 = agent('a1', 'sess-1', 'A1');
		const a2: PipelineNode = {
			...agent('a2', 'sess-2', 'A2'),
			data: {
				...(agent('a2', 'sess-2', 'A2').data as AgentNodeData),
				inputPrompt: 'follow up with a2',
			},
		};

		const pipelines = [
			pipeline(
				'Prompted',
				'#06b6d4',
				[t1, a1, a2],
				[edge('e1', 't1', 'a1', { prompt: 'kick off' }), edge('e2', 'a1', 'a2')]
			),
		];
		const sessions: PipelineSession[] = [
			{ id: 'sess-1', name: 'A1', toolType: 'claude-code' },
			{ id: 'sess-2', name: 'A2', toolType: 'claude-code' },
		];

		const [reconstructed] = roundTrip(pipelines, sessions);
		const a2Node = reconstructed.nodes.find(
			(n) => n.type === 'agent' && (n.data as AgentNodeData).sessionId === 'sess-2'
		);
		expect(a2Node).toBeDefined();
		// The downstream agent's input prompt survives the round-trip. The
		// reconstructor strips an auto-injected `{{CUE_SOURCE_OUTPUT}}\n\n`
		// prefix; the user-typed body must remain.
		expect((a2Node!.data as AgentNodeData).inputPrompt).toContain('follow up with a2');
	});
});

// ─── Shape: trigger event configs round-trip exactly ─────────────────────────

describe('round-trip: trigger event configs survive serialization', () => {
	function getReconstructedTriggerConfig(
		eventType: CueEventType,
		config: TriggerNodeData['config']
	): TriggerNodeData {
		const t1 = trigger('t1', eventType, config);
		const a1 = agent('a1', 'sess-a', 'Alpha');
		const pipelines = [
			pipeline('Trig', '#06b6d4', [t1, a1], [edge('e1', 't1', 'a1', { prompt: 'work' })]),
		];
		const sessions: PipelineSession[] = [{ id: 'sess-a', name: 'Alpha', toolType: 'claude-code' }];

		const [reconstructed] = roundTrip(pipelines, sessions);
		const triggerNode = reconstructed.nodes.find((n) => n.type === 'trigger')!;
		return triggerNode.data as TriggerNodeData;
	}

	it('time.heartbeat preserves interval_minutes', () => {
		const data = getReconstructedTriggerConfig('time.heartbeat', { interval_minutes: 17 });
		expect(data.eventType).toBe('time.heartbeat');
		expect(data.config.interval_minutes).toBe(17);
	});

	it('time.scheduled preserves schedule_times AND schedule_days', () => {
		const data = getReconstructedTriggerConfig('time.scheduled', {
			schedule_times: ['09:00', '17:30'],
			schedule_days: ['mon', 'wed', 'fri'],
		});
		expect(data.eventType).toBe('time.scheduled');
		expect(data.config.schedule_times).toEqual(['09:00', '17:30']);
		expect(data.config.schedule_days).toEqual(['mon', 'wed', 'fri']);
	});

	it('file.changed preserves watch and filter', () => {
		const data = getReconstructedTriggerConfig('file.changed', {
			watch: 'src/**/*.ts',
			filter: { extension: 'ts' },
		});
		expect(data.eventType).toBe('file.changed');
		expect(data.config.watch).toBe('src/**/*.ts');
		expect(data.config.filter).toEqual({ extension: 'ts' });
	});

	it('github.pull_request preserves repo and poll_minutes', () => {
		const data = getReconstructedTriggerConfig('github.pull_request', {
			repo: 'org/repo',
			poll_minutes: 15,
		});
		expect(data.eventType).toBe('github.pull_request');
		expect(data.config.repo).toBe('org/repo');
		expect(data.config.poll_minutes).toBe(15);
	});
});

// ─── Shape: double round-trip is a no-op (idempotence) ──────────────────────

describe('round-trip: double round-trip is structurally idempotent', () => {
	it('save → reload → save → reload produces the same structure as one round-trip', () => {
		// Catches drift bugs where one round-trip succeeds but a second
		// pass mutates fields (the kind of bug that only surfaces in the
		// field as "save N times and pipeline starts diverging").
		const t1 = trigger('t1', 'time.heartbeat', { interval_minutes: 5 });
		const a1 = agent('a1', 'sess-a', 'Alpha');
		const a2 = agent('a2', 'sess-b', 'Bravo');

		const pipelines = [
			pipeline(
				'Idem',
				'#06b6d4',
				[t1, a1, a2],
				[edge('e1', 't1', 'a1', { prompt: 'first' }), edge('e2', 'a1', 'a2', { prompt: 'second' })]
			),
		];
		const sessions: PipelineSession[] = [
			{ id: 'sess-a', name: 'Alpha', toolType: 'claude-code' },
			{ id: 'sess-b', name: 'Bravo', toolType: 'claude-code' },
		];

		const r1 = roundTrip(pipelines, sessions);
		const r2 = roundTrip(r1, sessions);

		// Structural equality on (nodeCount, edgeCount, agent membership).
		expect(r2).toHaveLength(r1.length);
		const summarize = (ps: CuePipeline[]) =>
			ps.map((p) => ({
				name: p.name,
				color: p.color,
				agentSessionIds: p.nodes
					.filter((n) => n.type === 'agent')
					.map((n) => (n.data as AgentNodeData).sessionId)
					.sort(),
				edgeCount: p.edges.length,
			}));
		expect(summarize(r2)).toEqual(summarize(r1));
	});
});
