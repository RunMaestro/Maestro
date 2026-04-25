/**
 * Regression tests for prompt-file cleanup when an agent node is deleted
 * from a Cue pipeline.
 *
 * User requirement: deleting an agent must remove ONLY that agent's
 * associated `.md` file from `.maestro/prompts/`, never a file still
 * referenced by another node. A single pipeline can legitimately contain
 * multiple instances of the same agent (e.g. A → B → A, or a duplicate
 * agent across fan-out branches) and each instance lives in its own
 * prompt file keyed by the subscription name — not by the agent name
 * alone — so the prune must be surgical.
 *
 * Exercises the full save path: renderer state → `pipelinesToYaml` →
 * writes prompt files + YAML to a real temp directory → simulates the
 * `cue:writeYaml` IPC handler's keep-set extraction → `pruneOrphanedPromptFiles`.
 * Asserts the pruned set is exactly the files owned by the deleted node
 * and nothing else.
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
import { pruneOrphanedPromptFiles } from '../../../main/cue/config/cue-config-repository';
import type {
	AgentNodeData,
	CuePipeline,
	PipelineEdge,
	PipelineNode,
	TriggerNodeData,
} from '../../../shared/cue-pipeline-types';

let projectRoot = '';

beforeEach(() => {
	projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-agent-delete-prune-'));
});

afterEach(() => {
	if (projectRoot && fs.existsSync(projectRoot)) {
		fs.rmSync(projectRoot, { recursive: true, force: true });
	}
});

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function trigger(id: string): PipelineNode {
	return {
		id,
		type: 'trigger',
		position: { x: 0, y: 0 },
		data: {
			eventType: 'app.startup',
			label: 'Startup',
			config: {},
		} as TriggerNodeData,
	};
}

function agent(id: string, sessionId: string, sessionName: string, prompt?: string): PipelineNode {
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

function writeAllPromptFiles(promptFiles: Map<string, string>) {
	for (const [relativePath, content] of promptFiles.entries()) {
		const abs = path.join(projectRoot, relativePath);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content, 'utf-8');
	}
}

/**
 * Mirrors what `cue:writeYaml` does: parse the new YAML to build the
 * keep-set of referenced prompt files, then prune everything else in
 * `.maestro/prompts/`. Returns the files actually removed from disk so
 * tests can assert the exact delta.
 */
function simulateSaveAndPrune(pipelines: CuePipeline[]): {
	keptOnDisk: string[];
	removed: string[];
} {
	const { yaml: yamlStr, promptFiles } = pipelinesToYaml(pipelines);
	writeAllPromptFiles(promptFiles);

	const keepPaths = new Set<string>();
	for (const rel of promptFiles.keys()) keepPaths.add(rel);
	const parsed = yaml.load(yamlStr) as {
		subscriptions?: Array<Record<string, unknown>>;
	} | null;
	if (parsed?.subscriptions) {
		for (const sub of parsed.subscriptions) {
			if (!sub || typeof sub !== 'object') continue;
			const pf = (sub as Record<string, unknown>).prompt_file;
			const opf = (sub as Record<string, unknown>).output_prompt_file;
			const fopf = (sub as Record<string, unknown>).fan_out_prompt_files;
			if (typeof pf === 'string') keepPaths.add(pf);
			if (typeof opf === 'string') keepPaths.add(opf);
			if (Array.isArray(fopf)) {
				for (const entry of fopf) if (typeof entry === 'string') keepPaths.add(entry);
			}
		}
	}

	const removed = pruneOrphanedPromptFiles(projectRoot, keepPaths);

	const promptsDir = path.join(projectRoot, '.maestro/prompts');
	const keptOnDisk: string[] = [];
	if (fs.existsSync(promptsDir)) {
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const abs = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(abs);
				else if (entry.isFile() && entry.name.endsWith('.md')) {
					keptOnDisk.push(path.relative(projectRoot, abs));
				}
			}
		};
		walk(promptsDir);
	}

	return {
		keptOnDisk: keptOnDisk.sort(),
		removed: removed.map((r) => path.relative(projectRoot, r)).sort(),
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("agent deletion prunes only the deleted node's prompt file", () => {
	it('deleting a chain-position instance of an agent that also appears at the trigger only removes the chain-position file', () => {
		// Pipeline: trigger → Codex (position 1) → Claude → Codex (position 2, same sessionId).
		// Two distinct Codex instances because the same agent can legitimately
		// appear multiple times in one pipeline (e.g. a round-trip refinement
		// pattern). Each instance has its own prompt file keyed by subscription
		// name, NOT agent name.
		const t1 = trigger('t1');
		const codex1 = agent('codex-1', 'sess-codex', 'Codex 1', 'first codex pass');
		const claude = agent('claude', 'sess-claude', 'Claude 1', 'claude middle');
		const codex2 = agent('codex-2', 'sess-codex', 'Codex 1', 'second codex pass');
		const initial: CuePipeline = {
			id: 'p1',
			name: 'Refine',
			color: '#06b6d4',
			nodes: [t1, codex1, claude, codex2],
			edges: [
				edge('e1', 't1', 'codex-1'),
				edge('e2', 'codex-1', 'claude'),
				edge('e3', 'claude', 'codex-2'),
			],
		};

		// Step 1: save the initial pipeline. Every node has its own .md file.
		simulateSaveAndPrune([initial]);
		const afterInitial = fs.readdirSync(path.join(projectRoot, '.maestro/prompts')).sort();
		expect(afterInitial).toEqual([
			'claude_1-refine-chain-1.md',
			'codex_1-refine-chain-2.md',
			'codex_1-refine.md',
		]);

		// Step 2: user deletes the SECOND Codex instance (the tail of the chain)
		// — simulated here by removing the node and its edges.
		const deleted: CuePipeline = {
			...initial,
			nodes: initial.nodes.filter((n) => n.id !== 'codex-2'),
			edges: initial.edges.filter((e) => e.source !== 'codex-2' && e.target !== 'codex-2'),
		};

		// Step 3: save again — prune must remove ONLY the tail Codex file.
		const { keptOnDisk, removed } = simulateSaveAndPrune([deleted]);

		// The first Codex's file (`codex_1-refine.md`) and Claude's file must
		// survive because they're still referenced by the surviving subs.
		expect(keptOnDisk).toEqual([
			'.maestro/prompts/claude_1-refine-chain-1.md',
			'.maestro/prompts/codex_1-refine.md',
		]);
		// The tail Codex's file is the ONLY one pruned.
		expect(removed).toEqual(['.maestro/prompts/codex_1-refine-chain-2.md']);
	});

	it("deleting one of several fan-out agents with differing prompts removes only that agent's file", () => {
		// Fan-out with three targets each carrying a unique prompt (written to
		// fan_out_prompt_files). Delete the middle target and verify only its
		// per-agent file is pruned.
		const t = trigger('t1');
		const a = agent('a', 'sess-a', 'Codex 1', 'codex work');
		const b = agent('b', 'sess-b', 'OpenCode 1', 'opencode work');
		const c = agent('c', 'sess-c', 'Claude 1', 'claude work');
		const initial: CuePipeline = {
			id: 'p1',
			name: 'FanOut',
			color: '#ef4444',
			nodes: [t, a, b, c],
			edges: [edge('e1', 't1', 'a'), edge('e2', 't1', 'b'), edge('e3', 't1', 'c')],
		};
		simulateSaveAndPrune([initial]);

		// Delete OpenCode (middle fan-out target).
		const deleted: CuePipeline = {
			...initial,
			nodes: initial.nodes.filter((n) => n.id !== 'b'),
			edges: initial.edges.filter((e) => e.source !== 'b' && e.target !== 'b'),
		};
		const { keptOnDisk, removed } = simulateSaveAndPrune([deleted]);

		expect(keptOnDisk).toEqual([
			'.maestro/prompts/claude_1-fanout.md',
			'.maestro/prompts/codex_1-fanout.md',
		]);
		expect(removed).toEqual(['.maestro/prompts/opencode_1-fanout.md']);
	});

	it('deleting a fan-out agent when all targets share the same prompt does NOT remove the shared file', () => {
		// When prompts are identical across fan-out targets, pipelineToYaml
		// collapses to a single shared prompt_file. Deleting one target
		// reduces fan_out but the remaining targets still reference the same
		// file — it MUST NOT be pruned.
		const t = trigger('t1');
		const a = agent('a', 'sess-a', 'Codex 1', 'shared prompt');
		const b = agent('b', 'sess-b', 'OpenCode 1', 'shared prompt');
		const c = agent('c', 'sess-c', 'Claude 1', 'shared prompt');
		const initial: CuePipeline = {
			id: 'p1',
			name: 'SharedFanOut',
			color: '#22c55e',
			nodes: [t, a, b, c],
			edges: [edge('e1', 't1', 'a'), edge('e2', 't1', 'b'), edge('e3', 't1', 'c')],
		};
		simulateSaveAndPrune([initial]);

		// Confirm initial: a single shared prompt file named after the first agent.
		const afterInitial = fs.readdirSync(path.join(projectRoot, '.maestro/prompts')).sort();
		expect(afterInitial).toEqual(['codex_1-sharedfanout.md']);

		// Delete OpenCode. Remaining fan-out: [Codex, Claude] — still share
		// the single prompt file, which must survive.
		const deleted: CuePipeline = {
			...initial,
			nodes: initial.nodes.filter((n) => n.id !== 'b'),
			edges: initial.edges.filter((e) => e.source !== 'b' && e.target !== 'b'),
		};
		const { keptOnDisk, removed } = simulateSaveAndPrune([deleted]);

		expect(keptOnDisk).toEqual(['.maestro/prompts/codex_1-sharedfanout.md']);
		expect(removed).toEqual([]);
	});

	it("deleting a middle chain agent breaks the chain and prunes only that agent's file", () => {
		const t = trigger('t1');
		const first = agent('first', 'sess-a', 'Alpha', 'A prompt');
		const middle = agent('middle', 'sess-b', 'Beta', 'B prompt');
		const last = agent('last', 'sess-c', 'Gamma', 'C prompt');
		const initial: CuePipeline = {
			id: 'p1',
			name: 'Chain',
			color: '#8b5cf6',
			nodes: [t, first, middle, last],
			edges: [
				edge('e1', 't1', 'first'),
				edge('e2', 'first', 'middle'),
				edge('e3', 'middle', 'last'),
			],
		};
		simulateSaveAndPrune([initial]);

		// Delete the middle agent (Beta). The chain breaks — Gamma is no
		// longer reachable, so its sub and prompt file also go away.
		const deleted: CuePipeline = {
			...initial,
			nodes: initial.nodes.filter((n) => n.id !== 'middle'),
			edges: initial.edges.filter((e) => e.source !== 'middle' && e.target !== 'middle'),
		};
		const { keptOnDisk, removed } = simulateSaveAndPrune([deleted]);

		// Only the initial sub (Alpha's) survives.
		expect(keptOnDisk).toEqual(['.maestro/prompts/alpha-chain.md']);
		expect(removed.sort()).toEqual(
			['.maestro/prompts/beta-chain-chain-1.md', '.maestro/prompts/gamma-chain-chain-2.md'].sort()
		);
	});

	it('does not touch prompt files owned by a sibling pipeline in the same project root', () => {
		// Two pipelines sharing a project root. Deleting an agent from
		// pipeline A must not prune prompt files owned by pipeline B.
		const pA: CuePipeline = {
			id: 'pA',
			name: 'A',
			color: '#06b6d4',
			nodes: [
				trigger('tA'),
				agent('aA', 'sess-a', 'Codex 1', 'a prompt'),
				agent('bA', 'sess-b', 'Claude 1', 'b prompt'),
			],
			edges: [edge('e1', 'tA', 'aA'), edge('e2', 'aA', 'bA')],
		};
		const pB: CuePipeline = {
			id: 'pB',
			name: 'B',
			color: '#ef4444',
			nodes: [
				trigger('tB'),
				agent('aB', 'sess-a', 'Codex 1', 'b-a prompt'),
				agent('bB', 'sess-b', 'Claude 1', 'b-b prompt'),
			],
			edges: [edge('e3', 'tB', 'aB'), edge('e4', 'aB', 'bB')],
		};
		simulateSaveAndPrune([pA, pB]);

		// Delete Claude from pipeline A only.
		const aReduced: CuePipeline = {
			...pA,
			nodes: pA.nodes.filter((n) => n.id !== 'bA'),
			edges: pA.edges.filter((e) => e.source !== 'bA' && e.target !== 'bA'),
		};
		const { keptOnDisk, removed } = simulateSaveAndPrune([aReduced, pB]);

		// Pipeline B's Claude file must survive — sharing sessionName with
		// the deleted agent doesn't matter because the file is keyed by sub
		// name, not agent name.
		expect(keptOnDisk).toContain('.maestro/prompts/claude_1-b-chain-1.md');
		expect(keptOnDisk).toContain('.maestro/prompts/codex_1-b.md');
		expect(keptOnDisk).toContain('.maestro/prompts/codex_1-a.md');
		// Only A's Claude file is removed.
		expect(removed).toEqual(['.maestro/prompts/claude_1-a-chain-1.md']);
	});
});
