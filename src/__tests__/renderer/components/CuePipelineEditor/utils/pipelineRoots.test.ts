/**
 * Tests for resolvePipelineWriteRoot / resolvePipelinesWriteRoots.
 *
 * These match handleSave's partitioning rules so that `lastWrittenRootsRef`
 * stays in sync with where YAMLs actually live. The cross-directory cases
 * are the regression test for #847 (deleted pipeline reappears because the
 * common-ancestor write root was never seeded into previousRoots).
 */

import { describe, it, expect } from 'vitest';
import {
	resolvePipelineWriteRoot,
	resolvePipelinesWriteRoots,
} from '../../../../../renderer/components/CuePipelineEditor/utils/pipelineRoots';
import type {
	AgentNodeData,
	CommandNodeData,
	CuePipeline,
	CuePipelineSessionInfo as SessionInfo,
} from '../../../../../shared/cue-pipeline-types';

type SessionRootInfo = Pick<SessionInfo, 'projectRoot'>;

function makeAgentNode(sessionId: string, sessionName: string): CuePipeline['nodes'][number] {
	return {
		id: `agent-${sessionId}`,
		type: 'agent',
		position: { x: 0, y: 0 },
		data: {
			sessionId,
			sessionName,
			toolType: 'claude-code',
			inputPrompt: '',
		} as AgentNodeData,
	};
}

function makeCommandNode(
	id: string,
	owningSessionId: string,
	owningSessionName: string,
	shell = 'echo hi'
): CuePipeline['nodes'][number] {
	return {
		id,
		type: 'command',
		position: { x: 0, y: 0 },
		data: {
			name: id,
			mode: 'shell',
			shell,
			owningSessionId,
			owningSessionName,
		} as CommandNodeData,
	};
}

function makeCommandOnlyPipeline(
	commands: Array<{
		id: string;
		owningSessionId: string;
		owningSessionName: string;
	}>
): CuePipeline {
	return {
		id: 'p-cmd',
		name: 'cmd-only',
		color: '#06b6d4',
		nodes: [
			{
				id: 'trigger-1',
				type: 'trigger',
				position: { x: 0, y: 0 },
				data: {
					eventType: 'time.scheduled',
					label: 'Daily',
					config: { schedule_times: ['06:00'] },
				},
			},
			...commands.map((c) => makeCommandNode(c.id, c.owningSessionId, c.owningSessionName)),
		],
		edges: [],
	};
}

function makePipeline(agents: Array<{ sessionId: string; sessionName: string }>): CuePipeline {
	return {
		id: 'p1',
		name: 'test',
		color: '#06b6d4',
		nodes: [
			{
				id: 'trigger-1',
				type: 'trigger',
				position: { x: 0, y: 0 },
				data: { eventType: 'time.heartbeat', label: 'Timer', config: {} },
			},
			...agents.map((a) => makeAgentNode(a.sessionId, a.sessionName)),
		],
		edges: [],
	};
}

function mapBy<T>(entries: Array<[string, T]>): ReadonlyMap<string, T> {
	return new Map(entries);
}

describe('resolvePipelineWriteRoot', () => {
	describe('single-root pipelines', () => {
		it('returns the common root when all agents share one project root', () => {
			const pipeline = makePipeline([
				{ sessionId: 's1', sessionName: 'alpha' },
				{ sessionId: 's2', sessionName: 'beta' },
			]);
			const byId = mapBy<SessionRootInfo>([
				['s1', { projectRoot: '/workspace/proj' }],
				['s2', { projectRoot: '/workspace/proj' }],
			]);
			expect(resolvePipelineWriteRoot(pipeline, byId, new Map())).toBe('/workspace/proj');
		});

		it('falls back to sessionName when sessionId is not found', () => {
			const pipeline = makePipeline([{ sessionId: 'missing', sessionName: 'alpha' }]);
			const byName = mapBy<SessionRootInfo>([['alpha', { projectRoot: '/workspace/proj' }]]);
			expect(resolvePipelineWriteRoot(pipeline, new Map(), byName)).toBe('/workspace/proj');
		});

		it('prefers sessionId over sessionName when both are present', () => {
			const pipeline = makePipeline([{ sessionId: 's1', sessionName: 'alpha' }]);
			const byId = mapBy<SessionRootInfo>([['s1', { projectRoot: '/via-id' }]]);
			const byName = mapBy<SessionRootInfo>([['alpha', { projectRoot: '/via-name' }]]);
			expect(resolvePipelineWriteRoot(pipeline, byId, byName)).toBe('/via-id');
		});
	});

	describe('cross-directory pipelines (regression for #847)', () => {
		it('collapses to common ancestor when agents span subdirectories', () => {
			// The #847 scenario: pipeline's YAML lives at /project, not at
			// /project/a or /project/Digest. Previously the load-time loop
			// added the two sub-roots and missed /project — so a delete+save
			// could not clear the stale YAML.
			const pipeline = makePipeline([
				{ sessionId: 's1', sessionName: 'frontend' },
				{ sessionId: 's2', sessionName: 'digest' },
			]);
			const byId = mapBy<SessionRootInfo>([
				['s1', { projectRoot: '/project/frontend' }],
				['s2', { projectRoot: '/project/Digest' }],
			]);
			expect(resolvePipelineWriteRoot(pipeline, byId, new Map())).toBe('/project');
		});

		it('returns null when agent roots span unrelated trees', () => {
			// handleSave rejects "agents span unrelated project roots" — we must
			// not seed a write-root we would never actually write to. Two paths
			// whose only shared prefix is filesystem root `/` fail the
			// isDescendantOrEqual check (since `/workspace/projA` does not start
			// with `//`), so the helper returns null — matching handleSave.
			const pipeline = makePipeline([
				{ sessionId: 's1', sessionName: 'alpha' },
				{ sessionId: 's2', sessionName: 'beta' },
			]);
			const byId = mapBy<SessionRootInfo>([
				['s1', { projectRoot: '/workspace/projA' }],
				['s2', { projectRoot: '/other/projB' }],
			]);
			expect(resolvePipelineWriteRoot(pipeline, byId, new Map())).toBeNull();
		});
	});

	describe('unresolvable pipelines', () => {
		it('returns null for an empty pipeline (no agents)', () => {
			const pipeline: CuePipeline = {
				id: 'empty',
				name: 'empty',
				color: '#06b6d4',
				nodes: [],
				edges: [],
			};
			expect(resolvePipelineWriteRoot(pipeline, new Map(), new Map())).toBeNull();
		});

		it('returns null when no agent resolves to a session with a projectRoot', () => {
			const pipeline = makePipeline([{ sessionId: 'missing', sessionName: 'gone' }]);
			expect(resolvePipelineWriteRoot(pipeline, new Map(), new Map())).toBeNull();
		});

		it('returns null when any agent is unresolvable (missingRoot parity with handleSave)', () => {
			// handleSave aborts the partition step for a pipeline with any
			// unresolvable agent; we mirror that so we do not seed a root the
			// save flow would never actually write to.
			const pipeline = makePipeline([
				{ sessionId: 's1', sessionName: 'alpha' },
				{ sessionId: 'missing', sessionName: 'gone' },
			]);
			const byId = mapBy<SessionRootInfo>([['s1', { projectRoot: '/workspace/proj' }]]);
			expect(resolvePipelineWriteRoot(pipeline, byId, new Map())).toBeNull();
		});

		it('returns null when projectRoot is undefined on the resolved session', () => {
			const pipeline = makePipeline([{ sessionId: 's1', sessionName: 'alpha' }]);
			const byId = mapBy<SessionRootInfo>([['s1', { projectRoot: undefined }]]);
			expect(resolvePipelineWriteRoot(pipeline, byId, new Map())).toBeNull();
		});

		it('treats empty-string sessionId/sessionName as unresolvable (defensive guard)', () => {
			// A stray `''` key in the session maps must not accidentally resolve an
			// agent whose identifiers are empty.
			const pipeline = makePipeline([{ sessionId: '', sessionName: '' }]);
			const byId = mapBy<SessionRootInfo>([['', { projectRoot: '/should-not-match' }]]);
			const byName = mapBy<SessionRootInfo>([['', { projectRoot: '/also-should-not-match' }]]);
			expect(resolvePipelineWriteRoot(pipeline, byId, byName)).toBeNull();
		});
	});

	describe('command-node-only pipelines (regression: command-only pipelines vanished on save)', () => {
		// A pipeline with a trigger plus shell/CLI command nodes (no agent
		// nodes) used to be silently dropped from handleSave because the
		// partition step only looked at agent nodes. Commands inherit cwd +
		// agent_id from their owning session, so they are first-class root
		// contributors.
		it("resolves the root from the command's owning session", () => {
			const pipeline = makeCommandOnlyPipeline([
				{ id: 'cmd-1', owningSessionId: 's-cyber', owningSessionName: 'Cyber Stocks' },
			]);
			const byId = mapBy<SessionRootInfo>([
				['s-cyber', { projectRoot: '/Users/me/Projects/Cyber-Stocks' }],
			]);
			expect(resolvePipelineWriteRoot(pipeline, byId, new Map())).toBe(
				'/Users/me/Projects/Cyber-Stocks'
			);
		});

		it('falls back to owningSessionName when owningSessionId is missing', () => {
			const pipeline = makeCommandOnlyPipeline([
				{ id: 'cmd-1', owningSessionId: 'missing', owningSessionName: 'Cyber Stocks' },
			]);
			const byName = mapBy<SessionRootInfo>([
				['Cyber Stocks', { projectRoot: '/Users/me/Projects/Cyber-Stocks' }],
			]);
			expect(resolvePipelineWriteRoot(pipeline, new Map(), byName)).toBe(
				'/Users/me/Projects/Cyber-Stocks'
			);
		});

		it('collapses sibling commands under a common ancestor root', () => {
			const pipeline = makeCommandOnlyPipeline([
				{ id: 'cmd-1', owningSessionId: 's1', owningSessionName: 'A' },
				{ id: 'cmd-2', owningSessionId: 's2', owningSessionName: 'B' },
			]);
			const byId = mapBy<SessionRootInfo>([
				['s1', { projectRoot: '/project/A' }],
				['s2', { projectRoot: '/project/B' }],
			]);
			expect(resolvePipelineWriteRoot(pipeline, byId, new Map())).toBe('/project');
		});

		it('returns null when the only command has no owning-session binding (treated as unbound)', () => {
			// An in-flight command with no owning-session set yet is unbound, not
			// missing — leave the pipeline unresolved so it does not seed a root.
			const pipeline = makeCommandOnlyPipeline([
				{ id: 'cmd-1', owningSessionId: '', owningSessionName: '' },
			]);
			expect(resolvePipelineWriteRoot(pipeline, new Map(), new Map())).toBeNull();
		});

		it("returns null when the command's owning session has no projectRoot", () => {
			// Binding present but unresolvable — mirror the agent-side missingRoot
			// rule so we never seed a root the save flow would never write to.
			const pipeline = makeCommandOnlyPipeline([
				{ id: 'cmd-1', owningSessionId: 's-cyber', owningSessionName: 'Cyber Stocks' },
			]);
			const byId = mapBy<SessionRootInfo>([['s-cyber', { projectRoot: undefined }]]);
			expect(resolvePipelineWriteRoot(pipeline, byId, new Map())).toBeNull();
		});

		it('mixes agent + command roots when both are present in the same pipeline', () => {
			const pipeline: CuePipeline = {
				id: 'mixed',
				name: 'mixed',
				color: '#06b6d4',
				nodes: [
					{
						id: 'trigger-1',
						type: 'trigger',
						position: { x: 0, y: 0 },
						data: { eventType: 'time.heartbeat', label: 'Timer', config: {} },
					},
					{
						id: 'agent-1',
						type: 'agent',
						position: { x: 0, y: 0 },
						data: {
							sessionId: 's-agent',
							sessionName: 'agent',
							toolType: 'claude-code',
							inputPrompt: '',
						} as AgentNodeData,
					},
					makeCommandNode('cmd-1', 's-cmd', 'cmd-session'),
				],
				edges: [],
			};
			const byId = mapBy<SessionRootInfo>([
				['s-agent', { projectRoot: '/project/agent' }],
				['s-cmd', { projectRoot: '/project/cmd' }],
			]);
			expect(resolvePipelineWriteRoot(pipeline, byId, new Map())).toBe('/project');
		});
	});
});

describe('resolvePipelinesWriteRoots', () => {
	it('unions distinct write roots across multiple pipelines', () => {
		const p1 = { ...makePipeline([{ sessionId: 's1', sessionName: 'alpha' }]), id: 'p1' };
		const p2 = { ...makePipeline([{ sessionId: 's2', sessionName: 'beta' }]), id: 'p2' };
		const byId = mapBy<SessionRootInfo>([
			['s1', { projectRoot: '/projA' }],
			['s2', { projectRoot: '/projB' }],
		]);
		const roots = resolvePipelinesWriteRoots([p1, p2], byId, new Map());
		expect(roots).toEqual(new Set(['/projA', '/projB']));
	});

	it('collapses duplicate roots to a single entry', () => {
		const p1 = { ...makePipeline([{ sessionId: 's1', sessionName: 'alpha' }]), id: 'p1' };
		const p2 = { ...makePipeline([{ sessionId: 's2', sessionName: 'beta' }]), id: 'p2' };
		const byId = mapBy<SessionRootInfo>([
			['s1', { projectRoot: '/projA' }],
			['s2', { projectRoot: '/projA' }],
		]);
		const roots = resolvePipelinesWriteRoots([p1, p2], byId, new Map());
		expect(roots).toEqual(new Set(['/projA']));
	});

	it('skips pipelines that do not resolve to a single write root', () => {
		const resolvable = { ...makePipeline([{ sessionId: 's1', sessionName: 'alpha' }]), id: 'p1' };
		const empty: CuePipeline = {
			id: 'p2',
			name: 'empty',
			color: '#06b6d4',
			nodes: [],
			edges: [],
		};
		const unresolvable = {
			...makePipeline([{ sessionId: 'missing', sessionName: 'gone' }]),
			id: 'p3',
		};
		const byId = mapBy<SessionRootInfo>([['s1', { projectRoot: '/projA' }]]);
		const roots = resolvePipelinesWriteRoots([resolvable, empty, unresolvable], byId, new Map());
		expect(roots).toEqual(new Set(['/projA']));
	});

	it('returns the common ancestor (not individual sub-roots) for cross-directory pipelines', () => {
		// Direct regression test for #847: the set MUST include '/project'
		// (where the YAML actually lives) and must NOT include the per-agent
		// subdirectories.
		const pipeline = makePipeline([
			{ sessionId: 's1', sessionName: 'frontend' },
			{ sessionId: 's2', sessionName: 'digest' },
		]);
		const byId = mapBy<SessionRootInfo>([
			['s1', { projectRoot: '/project/frontend' }],
			['s2', { projectRoot: '/project/Digest' }],
		]);
		const roots = resolvePipelinesWriteRoots([pipeline], byId, new Map());
		expect(roots).toEqual(new Set(['/project']));
		expect(roots.has('/project/frontend')).toBe(false);
		expect(roots.has('/project/Digest')).toBe(false);
	});
});
