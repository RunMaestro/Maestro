/**
 * Regression tests for pipeline-color persistence through YAML.
 *
 * Before Commit 3, colors were only emitted as human-readable comments
 * (`# Pipeline: X (color: #abc)`). On load, `subscriptionsToPipelines`
 * re-derived colors from palette order, causing colors to drift whenever
 * pipeline iteration order changed (Dashboard tab switch, modal reopen,
 * app restart). These tests lock in the new behaviour: `pipeline_color`
 * is part of the subscription schema and round-trips losslessly.
 */

import { describe, it, expect } from 'vitest';
import * as yaml from 'js-yaml';

import { pipelinesToYaml } from '../../../../../renderer/components/CuePipelineEditor/utils/pipelineToYaml';
import { subscriptionsToPipelines } from '../../../../../renderer/components/CuePipelineEditor/utils/yamlToPipeline';
import type {
	CuePipeline,
	PipelineNode,
	AgentNodeData,
	TriggerNodeData,
} from '../../../../../shared/cue-pipeline-types';
import type { CueSubscription, CueEventType } from '../../../../../shared/cue/contracts';

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
