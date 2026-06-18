/**
 * End-to-end regression test for the "fan-out pipeline vanishes on save
 * when prompts differ" bug.
 *
 * Reproduction steps (from the field report):
 *   1. Create a pipeline: one trigger → three agents (same project root).
 *   2. Assign identical prompts to all three agents. Save. Everything works.
 *   3. Change each agent's prompt to a unique value. Save.
 *   4. The entire pipeline disappears from the UI and does not come back
 *      on reload, even though `.maestro/cue.yaml` and the per-agent
 *      prompt files are on disk.
 *
 * Root cause: Commit 7 (fan-out per-agent prompt file externalization)
 * emitted YAML with only `fan_out_prompt_files` — no `prompt` or
 * `prompt_file`. The loader's `validateSubscription` required one of the
 * latter two, rejected the sub, and the lenient partition dropped it
 * from the config. With no surviving subscriptions, the graph had
 * nothing to render.
 *
 * This test exercises the full render pipeline:
 *   renderer save path (pipelinesToYaml)
 *     → validator (validateCueConfig)
 *     → normalizer (parseCueConfigDocument → materializeCueConfig)
 *     → renderer load path (subscriptionsToPipelines)
 * and asserts the pipeline survives unchanged through the cycle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import { pipelinesToYaml } from '../../../renderer/components/CuePipelineEditor/utils/pipelineToYaml';
import {
	subscriptionsToPipelines,
	graphSessionsToPipelines,
} from '../../../renderer/components/CuePipelineEditor/utils/yamlToPipeline';
import { loadCueConfigDetailed, validateCueConfig } from '../../../main/cue/cue-yaml-loader';
import {
	parseCueConfigDocument,
	materializeCueConfig,
} from '../../../main/cue/config/cue-config-normalizer';
import type {
	AgentNodeData,
	CueGraphSession,
	CuePipeline,
	PipelineEdge,
	PipelineNode,
	TriggerNodeData,
} from '../../../shared/cue-pipeline-types';
import type { CueSubscription } from '../../../shared/cue/contracts';

let projectRoot = '';

beforeEach(() => {
	projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-fanout-vanish-'));
	fs.mkdirSync(path.join(projectRoot, '.maestro/prompts'), { recursive: true });
});

afterEach(() => {
	if (projectRoot && fs.existsSync(projectRoot)) {
		fs.rmSync(projectRoot, { recursive: true, force: true });
	}
});

function trigger(id: string): PipelineNode {
	return {
		id,
		type: 'trigger',
		position: { x: 0, y: 0 },
		data: {
			eventType: 'app.startup',
			label: 'Trigger',
			config: {},
		} as TriggerNodeData,
	};
}

function agent(id: string, sessionId: string, sessionName: string, prompt: string): PipelineNode {
	return {
		id,
		type: 'agent',
		position: { x: 200, y: 0 },
		data: {
			sessionId,
			sessionName,
			toolType: 'claude-code',
			inputPrompt: prompt,
		} as AgentNodeData,
	};
}

function edge(id: string, source: string, target: string): PipelineEdge {
	return { id, source, target, mode: 'pass' };
}

function makeFanOutPipeline(prompts: [string, string, string]): CuePipeline {
	return {
		id: 'pipe-1',
		name: 'Pipeline 1',
		color: '#06b6d4',
		nodes: [
			trigger('t1'),
			agent('a1', 's-codex', 'Codex 1', prompts[0]),
			agent('a2', 's-opencode', 'OpenCode 1', prompts[1]),
			agent('a3', 's-claude', 'Claude 1', prompts[2]),
		],
		edges: [edge('e1', 't1', 'a1'), edge('e2', 't1', 'a2'), edge('e3', 't1', 'a3')],
	};
}

// Mirrors what the IPC layer does: writes the YAML and each referenced
// prompt file to the project root, then reads back through the full
// validator → normalizer → renderer chain.
function roundTripThroughDisk(pipe: CuePipeline): CuePipeline[] {
	const { yaml: yamlStr, promptFiles } = pipelinesToYaml([pipe]);

	// Write the prompt files exactly as the IPC writeYaml handler would.
	for (const [relativePath, content] of promptFiles.entries()) {
		const absPath = path.join(projectRoot, relativePath);
		fs.mkdirSync(path.dirname(absPath), { recursive: true });
		fs.writeFileSync(absPath, content, 'utf-8');
	}

	// Validate what the engine would validate.
	const parsed = yaml.load(yamlStr);
	const validation = validateCueConfig(parsed);
	expect(validation.valid).toBe(true);

	// Normalize → expands fan_out_prompt_files into fan_out_prompts inline.
	const doc = parseCueConfigDocument(yamlStr, projectRoot);
	expect(doc).not.toBeNull();
	const { config } = materializeCueConfig(doc!);
	const subs: CueSubscription[] = config.subscriptions;

	// Renderer load path.
	const sessions = [
		{ id: 's-codex', name: 'Codex 1', toolType: 'claude-code' as const },
		{ id: 's-opencode', name: 'OpenCode 1', toolType: 'claude-code' as const },
		{ id: 's-claude', name: 'Claude 1', toolType: 'claude-code' as const },
	];
	return subscriptionsToPipelines(subs, sessions);
}

describe('fan-out pipeline survives a save with differing per-agent prompts (regression)', () => {
	it('does NOT vanish when all three agents have unique prompts', () => {
		const pipe = makeFanOutPipeline(['codex work', 'opencode work', 'claude work']);
		const reconstructed = roundTripThroughDisk(pipe);

		expect(reconstructed).toHaveLength(1);
		const agentNames = reconstructed[0].nodes
			.filter((n) => n.type === 'agent')
			.map((n) => (n.data as AgentNodeData).sessionName);
		expect(agentNames).toEqual(expect.arrayContaining(['Codex 1', 'OpenCode 1', 'Claude 1']));

		// Each agent carries its own distinct prompt.
		const promptBySessionName: Record<string, string> = {};
		for (const node of reconstructed[0].nodes) {
			if (node.type === 'agent') {
				const data = node.data as AgentNodeData;
				promptBySessionName[data.sessionName] = data.inputPrompt ?? '';
			}
		}
		expect(promptBySessionName['Codex 1']).toBe('codex work');
		expect(promptBySessionName['OpenCode 1']).toBe('opencode work');
		expect(promptBySessionName['Claude 1']).toBe('claude work');
	});

	it('renders identically when all three agents share the same prompt (baseline)', () => {
		const pipe = makeFanOutPipeline(['same', 'same', 'same']);
		const reconstructed = roundTripThroughDisk(pipe);

		expect(reconstructed).toHaveLength(1);
		expect(reconstructed[0].nodes.filter((n) => n.type === 'agent')).toHaveLength(3);
	});

	it('survives the real engine load path when all three agents share a project root', () => {
		// The user's reported bug is specifically about three agents sharing
		// the same working directory. This test mirrors that scenario end-to-
		// end through the ACTUAL engine load path (`loadCueConfigDetailed` +
		// `graphSessionsToPipelines`), not the composed helpers.
		const pipe = makeFanOutPipeline(['codex unique', 'opencode unique', 'claude unique']);

		// Step 1: renderer save — write yaml + per-agent prompt files
		// exactly as the IPC layer would.
		const { yaml: yamlStr, promptFiles } = pipelinesToYaml([pipe]);
		fs.writeFileSync(path.join(projectRoot, '.maestro/cue.yaml'), yamlStr, 'utf-8');
		for (const [relPath, content] of promptFiles.entries()) {
			const absPath = path.join(projectRoot, relPath);
			fs.mkdirSync(path.dirname(absPath), { recursive: true });
			fs.writeFileSync(absPath, content, 'utf-8');
		}

		// Step 2: engine reload — three separate sessions all pointing at
		// the same project root, each gets its own SessionState that shares
		// the same underlying config.
		const detailed = loadCueConfigDetailed(projectRoot);
		expect(detailed.ok).toBe(true);
		if (!detailed.ok) return;
		expect(detailed.config.subscriptions).toHaveLength(1);

		// Step 3: graph data — each of the three sessions reports the
		// shared fan-out subscription as a participant. The renderer's
		// `graphSessionsToPipelines` dedupes by name but must still
		// reconstruct the full pipeline.
		const sharedSubs = detailed.config.subscriptions;
		// Explicit type annotation so the compiler catches any drift in the
		// CueGraphSession shape (e.g. a new required field) right here at
		// the call site rather than at the far-removed `graphSessionsToPipelines`
		// signature mismatch.
		const graphSessions: CueGraphSession[] = [
			{
				sessionId: 's-codex',
				sessionName: 'Codex 1',
				toolType: 'claude-code',
				subscriptions: sharedSubs,
			},
			{
				sessionId: 's-opencode',
				sessionName: 'OpenCode 1',
				toolType: 'claude-code',
				subscriptions: sharedSubs,
			},
			{
				sessionId: 's-claude',
				sessionName: 'Claude 1',
				toolType: 'claude-code',
				subscriptions: sharedSubs,
			},
		];
		const sessions = [
			{ id: 's-codex', name: 'Codex 1', toolType: 'claude-code' as const },
			{ id: 's-opencode', name: 'OpenCode 1', toolType: 'claude-code' as const },
			{ id: 's-claude', name: 'Claude 1', toolType: 'claude-code' as const },
		];
		const pipelines = graphSessionsToPipelines(graphSessions, sessions);

		// Step 4: the pipeline must be present with all three agents and
		// their unique prompts intact.
		expect(pipelines).toHaveLength(1);
		const agentByName: Record<string, string> = {};
		for (const node of pipelines[0].nodes) {
			if (node.type === 'agent') {
				const data = node.data as AgentNodeData;
				agentByName[data.sessionName] = data.inputPrompt ?? '';
			}
		}
		expect(agentByName['Codex 1']).toBe('codex unique');
		expect(agentByName['OpenCode 1']).toBe('opencode unique');
		expect(agentByName['Claude 1']).toBe('claude unique');
	});

	it('survives repeated save→load cycles after prompts diverge', () => {
		// Simulates the user's full flow: save with same prompts, reload,
		// edit to differ, save, reload, edit again, save.
		let pipe = makeFanOutPipeline(['v1', 'v1', 'v1']);
		let reconstructed = roundTripThroughDisk(pipe);
		expect(reconstructed).toHaveLength(1);

		pipe = { ...reconstructed[0] };
		// Change each agent's prompt independently.
		pipe.nodes = pipe.nodes.map((n) => {
			if (n.type !== 'agent') return n;
			const data = n.data as AgentNodeData;
			const prompt =
				data.sessionName === 'Codex 1'
					? 'edited codex'
					: data.sessionName === 'OpenCode 1'
						? 'edited opencode'
						: 'edited claude';
			return { ...n, data: { ...data, inputPrompt: prompt } };
		});

		reconstructed = roundTripThroughDisk(pipe);
		expect(reconstructed).toHaveLength(1);

		const byName: Record<string, string> = {};
		for (const node of reconstructed[0].nodes) {
			if (node.type === 'agent') {
				const data = node.data as AgentNodeData;
				byName[data.sessionName] = data.inputPrompt ?? '';
			}
		}
		expect(byName['Codex 1']).toBe('edited codex');
		expect(byName['OpenCode 1']).toBe('edited opencode');
		expect(byName['Claude 1']).toBe('edited claude');
	});
});
