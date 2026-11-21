// Source: src/__tests__/main/cue/cue-agent-delete-prune.test.ts
// Source: src/__tests__/main/cue/cue-fanout-vanishing-pipeline.test.ts
// Source: src/__tests__/main/cue/cue-yaml-error-paths.test.ts
// Source: src/__tests__/main/cue/cue-yaml-roundtrip.test.ts
// Source: src/__tests__/main/cue/cue-fanout-engine-load.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { pipelinesToYaml } from '../../../renderer/components/CuePipelineEditor/utils/pipelineToYaml';
import { pruneOrphanedPromptFiles } from '../../../main/cue/config/cue-config-repository';
import type { AgentNodeData } from '../../../shared/cue-pipeline-types';
import type { CuePipeline } from '../../../shared/cue-pipeline-types';
import type { PipelineEdge } from '../../../shared/cue-pipeline-types';
import type { PipelineNode } from '../../../shared/cue-pipeline-types';
import type { TriggerNodeData } from '../../../shared/cue-pipeline-types';
import { subscriptionsToPipelines } from '../../../renderer/components/CuePipelineEditor/utils/yamlToPipeline';
import { graphSessionsToPipelines } from '../../../renderer/components/CuePipelineEditor/utils/yamlToPipeline';
import { loadCueConfigDetailed } from '../../../main/cue/cue-yaml-loader';
import { validateCueConfig } from '../../../main/cue/cue-yaml-loader';
import { parseCueConfigDocument } from '../../../main/cue/config/cue-config-normalizer';
import { materializeCueConfig } from '../../../main/cue/config/cue-config-normalizer';
import type { CueGraphSession } from '../../../shared/cue-pipeline-types';
import type { CueSubscription } from '../../../shared/cue/contracts';
import { readCueConfigFile } from '../../../main/cue/config/cue-config-repository';
import { watchCueConfigFile } from '../../../main/cue/config/cue-config-repository';
import { deleteCueConfigFile } from '../../../main/cue/config/cue-config-repository';
import { resolveCueConfigPath } from '../../../main/cue/config/cue-config-repository';
import { writeCueConfigFile } from '../../../main/cue/config/cue-config-repository';
import { writeCuePromptFile } from '../../../main/cue/config/cue-config-repository';
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));
describeSourceSuite('cue-agent-delete-prune', () => {
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

	function agent(
		id: string,
		sessionId: string,
		sessionName: string,
		prompt?: string
	): PipelineNode {
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

		// `path.relative` yields OS-native separators (`\` on Windows). Normalize to
		// forward slashes so the assertions below can use POSIX-style literals on
		// every platform (a no-op transform on POSIX).
		const toPosix = (p: string) => p.replace(/\\/g, '/');
		return {
			keptOnDisk: keptOnDisk.map(toPosix).sort(),
			removed: removed.map((r) => toPosix(path.relative(projectRoot, r))).sort(),
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
			// - simulated here by removing the node and its edges.
			const deleted: CuePipeline = {
				...initial,
				nodes: initial.nodes.filter((n) => n.id !== 'codex-2'),
				edges: initial.edges.filter((e) => e.source !== 'codex-2' && e.target !== 'codex-2'),
			};

			// Step 3: save again - prune must remove ONLY the tail Codex file.
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
			// file - it MUST NOT be pruned.
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

			// Delete OpenCode. Remaining fan-out: [Codex, Claude] - still share
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

			// Delete the middle agent (Beta). The chain breaks - Gamma is no
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

			// Pipeline B's Claude file must survive - sharing sessionName with
			// the deleted agent doesn't matter because the file is keyed by sub
			// name, not agent name.
			expect(keptOnDisk).toContain('.maestro/prompts/claude_1-b-chain-1.md');
			expect(keptOnDisk).toContain('.maestro/prompts/codex_1-b.md');
			expect(keptOnDisk).toContain('.maestro/prompts/codex_1-a.md');
			// Only A's Claude file is removed.
			expect(removed).toEqual(['.maestro/prompts/claude_1-a-chain-1.md']);
		});
	});
});
describeSourceSuite('cue-fanout-vanishing-pipeline', () => {
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

			// Step 1: renderer save - write yaml + per-agent prompt files
			// exactly as the IPC layer would.
			const { yaml: yamlStr, promptFiles } = pipelinesToYaml([pipe]);
			fs.writeFileSync(path.join(projectRoot, '.maestro/cue.yaml'), yamlStr, 'utf-8');
			for (const [relPath, content] of promptFiles.entries()) {
				const absPath = path.join(projectRoot, relPath);
				fs.mkdirSync(path.dirname(absPath), { recursive: true });
				fs.writeFileSync(absPath, content, 'utf-8');
			}

			// Step 2: engine reload - three separate sessions all pointing at
			// the same project root, each gets its own SessionState that shares
			// the same underlying config.
			const detailed = loadCueConfigDetailed(projectRoot);
			expect(detailed.ok).toBe(true);
			if (!detailed.ok) return;
			expect(detailed.config.subscriptions).toHaveLength(1);

			// Step 3: graph data - each of the three sessions reports the
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
});
describeSourceSuite('cue-yaml-error-paths', () => {
	let projectRoot = '';

	beforeEach(() => {
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-errors-'));
	});

	afterEach(() => {
		if (projectRoot && fs.existsSync(projectRoot)) {
			fs.rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	describe('malformed YAML handling', () => {
		it('validateCueConfig flags a non-object root', () => {
			const result = validateCueConfig('plain string') as { valid: boolean; errors: string[] };
			expect(result.valid).toBe(false);
			expect(result.errors.length).toBeGreaterThan(0);
		});

		it('validateCueConfig flags a missing subscriptions array', () => {
			const result = validateCueConfig({ settings: {} }) as { valid: boolean; errors: string[] };
			expect(result.valid).toBe(false);
		});

		it('validateCueConfig accepts a minimal valid config', () => {
			const result = validateCueConfig({ subscriptions: [] }) as {
				valid: boolean;
				errors: string[];
			};
			expect(result.valid).toBe(true);
			expect(result.errors).toEqual([]);
		});
	});

	describe('missing-file tolerance', () => {
		it('readCueConfigFile returns null for a missing file (no throw)', () => {
			expect(readCueConfigFile(projectRoot)).toBeNull();
		});

		it('pruneOrphanedPromptFiles returns empty array when prompts dir does not exist', () => {
			expect(pruneOrphanedPromptFiles(projectRoot, [])).toEqual([]);
		});
	});

	describe('watchCueConfigFile torn-flag guard', () => {
		it('cleanup stops further onChange invocations even if debounce would fire', async () => {
			// Regression: the hardening added a `torn` flag so that any debounced
			// callback scheduled just before cleanup can't fire after the watcher
			// is closed. Without this, a session teardown overlapping with a file
			// change could re-trigger refreshSession on a session that no longer
			// exists.
			const onChange = vi.fn();
			// Deterministic setup: wait for chokidar's 'ready' event via the
			// opt-in hook instead of sleeping on a timer. The prior 50ms sleep
			// raced with chokidar's initial scan on slow CI runners and made
			// this assertion trivially pass when no change event ever fired.
			let cleanup!: () => void;
			await new Promise<void>((resolve) => {
				cleanup = watchCueConfigFile(projectRoot, onChange, { onReady: resolve });
			});

			// Trigger a real change so the debounced callback is scheduled - this
			// exercises the path the torn flag actually protects. Writing the
			// canonical .maestro/cue.yaml is exactly what the session runtime does.
			const maestroDir = path.join(projectRoot, '.maestro');
			fs.mkdirSync(maestroDir, { recursive: true });
			fs.writeFileSync(path.join(maestroDir, 'cue.yaml'), 'subscriptions: []', 'utf-8');

			// Cleanup IMMEDIATELY - the debounced setTimeout is already scheduled
			// (or about to be). The torn flag must reject it when it fires.
			cleanup();

			// Wait beyond the 1s debounce window - nothing should fire.
			await new Promise((resolve) => setTimeout(resolve, 1200));
			expect(onChange).not.toHaveBeenCalled();
		});

		it('cleanup is idempotent and does not leak an unhandled rejection', async () => {
			const onChange = vi.fn();
			const cleanup = watchCueConfigFile(projectRoot, onChange);

			// chokidar.close() returns a Promise. We don't await it, so any
			// rejection on a double-close would surface as an unhandled rejection
			// rather than a synchronous throw - watch for both.
			const unhandled: unknown[] = [];
			const onUnhandled = (event: { reason?: unknown } | PromiseRejectionEvent) => {
				unhandled.push((event as { reason?: unknown }).reason);
			};
			process.on('unhandledRejection', onUnhandled);

			try {
				cleanup();
				// Second call must not throw synchronously…
				expect(() => cleanup()).not.toThrow();
				// …and must not produce an async rejection either. Give the
				// microtask queue a tick to surface one if it's going to.
				await new Promise((resolve) => setTimeout(resolve, 50));
				expect(unhandled).toEqual([]);
			} finally {
				process.off('unhandledRejection', onUnhandled);
			}
		});
	});

	describe('recovery-service negative-gap guard', () => {
		// Exercised via the CueRecoveryService directly to lock in the clock-
		// moved-backward handling added in this release.
		let mockGetLastHeartbeat: ReturnType<typeof vi.fn>;
		let mockRecordHeartbeat: ReturnType<typeof vi.fn>;

		beforeEach(() => {
			mockGetLastHeartbeat = vi.fn();
			mockRecordHeartbeat = vi.fn();
		});

		afterEach(() => {
			// vi.restoreAllMocks undoes vi.spyOn(Date, 'now') below (and any other
			// spies), removing the need for manual save/restore bookkeeping.
			vi.restoreAllMocks();
			vi.resetModules();
		});

		it('skips reconciliation and logs when the heartbeat is in the future', async () => {
			// Simulate system clock set backward: lastHeartbeat is after "now".
			vi.resetModules();
			vi.doMock('../../../main/cue/cue-db', () => ({
				initCueDb: () => ({ ok: true }),
				getLastHeartbeat: mockGetLastHeartbeat,
				recordHeartbeat: mockRecordHeartbeat,
				getCueEventsBySession: () => [],
				closeCueDb: () => {},
				pruneCueEvents: vi.fn(),
				failOrphanedRunningEvents: vi.fn(() => 0),
			}));

			const { createCueRecoveryService } = await import('../../../main/cue/cue-recovery-service');

			const onLog = vi.fn();
			const reconcileSession = vi.fn();
			const service = createCueRecoveryService({
				enabled: () => true,
				getSessions: () => new Map(),
				onLog,
				reconcileSession,
			});

			// Init opens the DB (mocked as a no-op here).
			service.init();

			// Heartbeat is 10 seconds in the future - gapMs will be negative.
			vi.spyOn(Date, 'now').mockReturnValue(1000);
			mockGetLastHeartbeat.mockReturnValue(11000);

			service.detectSleepAndReconcile();

			expect(onLog).toHaveBeenCalledWith('cue', expect.stringContaining('Clock moved backward'));
			// Regression gate: a future version that logged the warning but
			// ALSO ran reconciliation (or rewrote the heartbeat) would defeat
			// the whole point of the guard. Pin both side-effects off.
			expect(reconcileSession).not.toHaveBeenCalled();
			expect(mockRecordHeartbeat).not.toHaveBeenCalled();
		});
	});
});
describeSourceSuite('cue-yaml-roundtrip', () => {
	let projectRoot = '';

	beforeEach(() => {
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-roundtrip-'));
	});

	afterEach(() => {
		if (projectRoot && fs.existsSync(projectRoot)) {
			fs.rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	describe('cue YAML roundtrip', () => {
		it('write → read returns the exact content with a single trip', () => {
			const content =
				'subscriptions:\n  - name: test-sub\n    event: time.heartbeat\n    interval_minutes: 5\n';
			writeCueConfigFile(projectRoot, content);

			const result = readCueConfigFile(projectRoot);
			expect(result).not.toBeNull();
			expect(result!.raw).toBe(content);
		});

		it('write creates .maestro/ directory if missing', () => {
			const maestroDir = path.join(projectRoot, '.maestro');
			expect(fs.existsSync(maestroDir)).toBe(false);

			writeCueConfigFile(projectRoot, 'subscriptions: []');

			expect(fs.existsSync(maestroDir)).toBe(true);
			expect(fs.existsSync(path.join(maestroDir, 'cue.yaml'))).toBe(true);
		});

		it('roundtrip preserves UTF-8 characters including emoji and CJK', () => {
			const content = 'subscriptions:\n  - name: "テスト 🎌 中文"\n    event: time.heartbeat\n';
			writeCueConfigFile(projectRoot, content);
			const result = readCueConfigFile(projectRoot);
			expect(result!.raw).toBe(content);
		});

		it('readCueConfigFile returns null when no config exists', () => {
			expect(readCueConfigFile(projectRoot)).toBeNull();
		});

		it('resolveCueConfigPath prefers canonical over legacy when both exist', () => {
			const legacyPath = path.join(projectRoot, 'maestro-cue.yaml');
			const canonicalDir = path.join(projectRoot, '.maestro');
			fs.mkdirSync(canonicalDir, { recursive: true });
			fs.writeFileSync(legacyPath, 'legacy', 'utf-8');
			fs.writeFileSync(path.join(canonicalDir, 'cue.yaml'), 'canonical', 'utf-8');

			const resolved = resolveCueConfigPath(projectRoot);
			expect(resolved).toBe(path.join(canonicalDir, 'cue.yaml'));
		});

		it('falls back to legacy path when canonical is missing', () => {
			const legacyPath = path.join(projectRoot, 'maestro-cue.yaml');
			fs.writeFileSync(legacyPath, 'legacy: true', 'utf-8');

			const result = readCueConfigFile(projectRoot);
			expect(result!.raw).toBe('legacy: true');
			expect(result!.filePath).toBe(legacyPath);
		});

		it('deleteCueConfigFile removes the file and returns true', () => {
			writeCueConfigFile(projectRoot, 'subscriptions: []');
			expect(deleteCueConfigFile(projectRoot)).toBe(true);
			expect(readCueConfigFile(projectRoot)).toBeNull();
		});

		it('deleteCueConfigFile returns false when no file exists', () => {
			expect(deleteCueConfigFile(projectRoot)).toBe(false);
		});
	});

	describe('cue prompt-file roundtrip', () => {
		it('writes a .md prompt file and reads it back', () => {
			const rel = '.maestro/prompts/sub-1.md';
			writeCuePromptFile(projectRoot, rel, 'body content');
			const full = path.join(projectRoot, rel);
			expect(fs.readFileSync(full, 'utf-8')).toBe('body content');
		});

		it('creates nested subdirectories under .maestro/prompts/', () => {
			writeCuePromptFile(projectRoot, '.maestro/prompts/nested/deep/sub.md', 'body');
			expect(fs.existsSync(path.join(projectRoot, '.maestro/prompts/nested/deep/sub.md'))).toBe(
				true
			);
		});

		it('rejects absolute paths', () => {
			expect(() => writeCuePromptFile(projectRoot, '/etc/passwd.md', 'evil')).toThrow(
				/relativePath must be relative/
			);
		});

		it('rejects paths that escape the prompts directory', () => {
			expect(() =>
				writeCuePromptFile(projectRoot, '.maestro/prompts/../../escape.md', 'evil')
			).toThrow(/resolves outside the prompts directory/);
		});

		it('rejects non-.md files', () => {
			expect(() => writeCuePromptFile(projectRoot, '.maestro/prompts/payload.sh', 'evil')).toThrow(
				/must end with .md/
			);
		});
	});

	describe('orphan prompt file pruning', () => {
		it('removes .md files not in the keep-set', () => {
			writeCuePromptFile(projectRoot, '.maestro/prompts/keep.md', 'keep');
			writeCuePromptFile(projectRoot, '.maestro/prompts/drop.md', 'drop');

			const removed = pruneOrphanedPromptFiles(projectRoot, ['.maestro/prompts/keep.md']);

			expect(removed).toHaveLength(1);
			expect(removed[0]).toContain('drop.md');
			expect(fs.existsSync(path.join(projectRoot, '.maestro/prompts/keep.md'))).toBe(true);
			expect(fs.existsSync(path.join(projectRoot, '.maestro/prompts/drop.md'))).toBe(false);
		});

		it('preserves non-.md files (only markdown is managed)', () => {
			// Someone may have dropped a README.txt or similar next to prompts -
			// pruning should not touch anything that isn't a .md file, since only
			// .md files are produced by the prompt-file writer.
			writeCuePromptFile(projectRoot, '.maestro/prompts/referenced.md', 'x');
			const extraPath = path.join(projectRoot, '.maestro/prompts/other.txt');
			fs.writeFileSync(extraPath, 'keep me', 'utf-8');

			const removed = pruneOrphanedPromptFiles(projectRoot, ['.maestro/prompts/referenced.md']);

			expect(removed).toHaveLength(0);
			expect(fs.existsSync(extraPath)).toBe(true);
		});

		it('returns empty array when prompts directory does not exist', () => {
			expect(pruneOrphanedPromptFiles(projectRoot, [])).toEqual([]);
		});

		it('handles nested subdirectories under prompts/', () => {
			writeCuePromptFile(projectRoot, '.maestro/prompts/a/keep.md', 'keep');
			writeCuePromptFile(projectRoot, '.maestro/prompts/b/drop.md', 'drop');

			const removed = pruneOrphanedPromptFiles(projectRoot, ['.maestro/prompts/a/keep.md']);
			expect(removed).toHaveLength(1);
			expect(removed[0]).toContain(path.join('b', 'drop.md'));
		});

		it('skips absolute paths in the keep-set', () => {
			// Ensures the keep-set filter matches the writer contract (reject
			// absolute paths) and doesn't accidentally protect a file via a weird
			// absolute entry that wouldn't hit the path.resolve check.
			writeCuePromptFile(projectRoot, '.maestro/prompts/one.md', 'x');
			const removed = pruneOrphanedPromptFiles(projectRoot, ['/absolute/ignored.md']);
			expect(removed).toHaveLength(1);
			expect(removed[0]).toContain('one.md');
		});
	});

	describe('yaml + prompt-file full roundtrip', () => {
		it('write YAML + prompt files → read back → same data', () => {
			const yaml = [
				'subscriptions:',
				'  - name: morning',
				'    event: time.scheduled',
				'    prompt_file: .maestro/prompts/morning.md',
				'  - name: output-prompt',
				'    event: agent.completed',
				'    prompt_file: .maestro/prompts/output.md',
				'    output_prompt_file: .maestro/prompts/output-phase2.md',
				'',
			].join('\n');

			writeCueConfigFile(projectRoot, yaml);
			writeCuePromptFile(projectRoot, '.maestro/prompts/morning.md', 'morning body');
			writeCuePromptFile(projectRoot, '.maestro/prompts/output.md', 'output body');
			writeCuePromptFile(projectRoot, '.maestro/prompts/output-phase2.md', 'phase-2 body');

			// Roundtrip YAML
			expect(readCueConfigFile(projectRoot)!.raw).toBe(yaml);

			// All prompts on disk
			expect(fs.readFileSync(path.join(projectRoot, '.maestro/prompts/morning.md'), 'utf-8')).toBe(
				'morning body'
			);
			expect(fs.readFileSync(path.join(projectRoot, '.maestro/prompts/output.md'), 'utf-8')).toBe(
				'output body'
			);
			expect(
				fs.readFileSync(path.join(projectRoot, '.maestro/prompts/output-phase2.md'), 'utf-8')
			).toBe('phase-2 body');

			// Simulate deleting one subscription and pruning - only referenced files remain
			const removed = pruneOrphanedPromptFiles(projectRoot, [
				'.maestro/prompts/morning.md',
				'.maestro/prompts/output.md',
			]);
			expect(removed).toHaveLength(1);
			expect(removed[0]).toContain('output-phase2.md');
			expect(fs.existsSync(path.join(projectRoot, '.maestro/prompts/output-phase2.md'))).toBe(
				false
			);
		});

		it('overwriting YAML+prompts preserves the rest of .maestro/', () => {
			// User may have unrelated files (e.g. director-notes, other tooling)
			// in .maestro/ - we must not blow them away.
			const maestroDir = path.join(projectRoot, '.maestro');
			fs.mkdirSync(maestroDir, { recursive: true });
			fs.writeFileSync(path.join(maestroDir, 'director-notes.md'), 'notes', 'utf-8');

			writeCueConfigFile(projectRoot, 'subscriptions: []');
			writeCuePromptFile(projectRoot, '.maestro/prompts/x.md', 'body');

			expect(fs.readFileSync(path.join(maestroDir, 'director-notes.md'), 'utf-8')).toBe('notes');
		});
	});
});
describeSourceSuite('cue-fanout-engine-load', () => {
	let projectRoot = '';

	beforeEach(() => {
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-fanout-engine-'));
		fs.mkdirSync(path.join(projectRoot, '.maestro/prompts'), { recursive: true });
	});

	afterEach(() => {
		if (projectRoot && fs.existsSync(projectRoot)) {
			fs.rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	function writeFile(relPath: string, content: string) {
		const abs = path.join(projectRoot, relPath);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content, 'utf-8');
	}

	describe('loadCueConfigDetailed - fan-out with per-agent prompt files', () => {
		it('loads the fan-out subscription instead of skipping it as invalid', () => {
			// Exactly the shape the renderer emits post-Commit-7.
			writeFile(
				'.maestro/cue.yaml',
				[
					'subscriptions:',
					'  - name: Pipeline 1',
					'    event: app.startup',
					'    agent_id: sess-codex',
					'    pipeline_name: Pipeline 1',
					"    pipeline_color: '#06b6d4'",
					'    fan_out:',
					'      - Codex 1',
					'      - OpenCode 1',
					'      - Claude 1',
					'    fan_out_prompt_files:',
					'      - .maestro/prompts/codex_1-pipeline_1.md',
					'      - .maestro/prompts/opencode_1-pipeline_1.md',
					'      - .maestro/prompts/claude_1-pipeline_1.md',
					'settings:',
					'  timeout_minutes: 30',
					'  timeout_on_fail: break',
					'  max_concurrent: 1',
					'  queue_size: 10',
					'',
				].join('\n')
			);
			writeFile('.maestro/prompts/codex_1-pipeline_1.md', 'codex work');
			writeFile('.maestro/prompts/opencode_1-pipeline_1.md', 'opencode work');
			writeFile('.maestro/prompts/claude_1-pipeline_1.md', 'claude work');

			const result = loadCueConfigDetailed(projectRoot);
			expect(result.ok).toBe(true);
			if (!result.ok) return; // type narrowing for TS

			// The sub MUST survive the lenient partition - this is the exact
			// place that used to silently drop it (validator error) and cause
			// the pipeline to vanish from the UI after reload.
			expect(result.config.subscriptions).toHaveLength(1);

			const sub = result.config.subscriptions[0];
			expect(sub.fan_out).toEqual(['Codex 1', 'OpenCode 1', 'Claude 1']);
			expect(sub.fan_out_prompts).toEqual(['codex work', 'opencode work', 'claude work']);
			expect(sub.fan_out_prompt_files).toEqual([
				'.maestro/prompts/codex_1-pipeline_1.md',
				'.maestro/prompts/opencode_1-pipeline_1.md',
				'.maestro/prompts/claude_1-pipeline_1.md',
			]);
			// pipeline_name / pipeline_color must round-trip for UI grouping.
			expect(sub.pipeline_name).toBe('Pipeline 1');
			expect(sub.pipeline_color).toBe('#06b6d4');
		});

		it('loads the fan-out subscription with legacy inline fan_out_prompts', () => {
			writeFile(
				'.maestro/cue.yaml',
				[
					'subscriptions:',
					'  - name: Legacy Pipeline',
					'    event: app.startup',
					'    agent_id: sess-a',
					'    fan_out:',
					'      - A',
					'      - B',
					'    fan_out_prompts:',
					'      - "do A"',
					'      - "do B"',
					'settings:',
					'  timeout_minutes: 30',
					'  timeout_on_fail: break',
					'  max_concurrent: 1',
					'  queue_size: 10',
					'',
				].join('\n')
			);

			const result = loadCueConfigDetailed(projectRoot);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.config.subscriptions).toHaveLength(1);
			expect(result.config.subscriptions[0].fan_out_prompts).toEqual(['do A', 'do B']);
		});

		it('does NOT report a warning about skipped subscriptions for a valid fan-out', () => {
			// Regression guard: even if validation passed now, a stray warning
			// in `result.warnings` would surface in logs as if something failed.
			writeFile(
				'.maestro/cue.yaml',
				[
					'subscriptions:',
					'  - name: Clean',
					'    event: app.startup',
					'    fan_out: [A, B]',
					'    fan_out_prompt_files:',
					'      - .maestro/prompts/a.md',
					'      - .maestro/prompts/b.md',
					'settings:',
					'  timeout_minutes: 30',
					'  timeout_on_fail: break',
					'  max_concurrent: 1',
					'  queue_size: 10',
					'',
				].join('\n')
			);
			writeFile('.maestro/prompts/a.md', 'a');
			writeFile('.maestro/prompts/b.md', 'b');

			const result = loadCueConfigDetailed(projectRoot);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.warnings.filter((w) => /Skipped invalid subscription/.test(w))).toEqual([]);
		});
	});
});
