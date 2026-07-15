/**
 * Tests for resolvePipelineOwnerCwds / resolvePipelinesWriteRoots.
 *
 * Per-agent-cwd model: a pipeline writes one yaml per participating agent's
 * cwd. The historical "collapse multi-cwd pipelines onto a common ancestor"
 * behavior was removed (it produced misplaced cue.yaml files at shared
 * parents like ~/Projects). These tests pin the new semantics: each bound
 * node contributes its own owning cwd to the result; cross-cwd pipelines
 * resolve to the SET of cwds, not a single ancestor.
 */

import { describe, it, expect } from 'vitest';
import {
	resolvePipelineOwnerCwds,
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

describe('resolvePipelineOwnerCwds', () => {
	describe('single-cwd pipelines', () => {
		it('returns one cwd when every agent shares the same project root', () => {
			const pipeline = makePipeline([
				{ sessionId: 's1', sessionName: 'alpha' },
				{ sessionId: 's2', sessionName: 'beta' },
			]);
			const byId = mapBy<SessionRootInfo>([
				['s1', { projectRoot: '/workspace/proj' }],
				['s2', { projectRoot: '/workspace/proj' }],
			]);
			const result = resolvePipelineOwnerCwds(pipeline, byId, new Map());
			expect(result).toEqual({ ok: true, cwds: new Set(['/workspace/proj']) });
		});

		it('falls back to sessionName when sessionId is not found', () => {
			const pipeline = makePipeline([{ sessionId: 'missing', sessionName: 'alpha' }]);
			const byName = mapBy<SessionRootInfo>([['alpha', { projectRoot: '/workspace/proj' }]]);
			const result = resolvePipelineOwnerCwds(pipeline, new Map(), byName);
			expect(result).toEqual({ ok: true, cwds: new Set(['/workspace/proj']) });
		});

		it('prefers sessionId over sessionName when both are present', () => {
			const pipeline = makePipeline([{ sessionId: 's1', sessionName: 'alpha' }]);
			const byId = mapBy<SessionRootInfo>([['s1', { projectRoot: '/via-id' }]]);
			const byName = mapBy<SessionRootInfo>([['alpha', { projectRoot: '/via-name' }]]);
			const result = resolvePipelineOwnerCwds(pipeline, byId, byName);
			expect(result).toEqual({ ok: true, cwds: new Set(['/via-id']) });
		});
	});

	describe('cross-cwd pipelines', () => {
		it('returns every distinct cwd when agents span subdirectories (no common-ancestor collapse)', () => {
			// The historical behavior collapsed this to '/project'. The
			// per-agent-cwd model writes ONE yaml per cwd instead, so the
			// caller must see the full owner set.
			const pipeline = makePipeline([
				{ sessionId: 's1', sessionName: 'frontend' },
				{ sessionId: 's2', sessionName: 'digest' },
			]);
			const byId = mapBy<SessionRootInfo>([
				['s1', { projectRoot: '/project/frontend' }],
				['s2', { projectRoot: '/project/Digest' }],
			]);
			const result = resolvePipelineOwnerCwds(pipeline, byId, new Map());
			expect(result).toEqual({
				ok: true,
				cwds: new Set(['/project/frontend', '/project/Digest']),
			});
		});

		it('returns every distinct cwd when agents are in unrelated trees', () => {
			// The previous model rejected this as "spans unrelated project
			// roots". Per-agent-cwd has no such restriction - each agent's
			// cue.yaml is independent; cross-tree references resolve at
			// runtime via agent_id lookups.
			const pipeline = makePipeline([
				{ sessionId: 's1', sessionName: 'alpha' },
				{ sessionId: 's2', sessionName: 'beta' },
			]);
			const byId = mapBy<SessionRootInfo>([
				['s1', { projectRoot: '/workspace/projA' }],
				['s2', { projectRoot: '/other/projB' }],
			]);
			const result = resolvePipelineOwnerCwds(pipeline, byId, new Map());
			expect(result).toEqual({
				ok: true,
				cwds: new Set(['/workspace/projA', '/other/projB']),
			});
		});
	});

	describe('unresolvable pipelines', () => {
		it("returns 'no-bindings' for an empty pipeline", () => {
			const pipeline: CuePipeline = {
				id: 'empty',
				name: 'empty',
				color: '#06b6d4',
				nodes: [],
				edges: [],
			};
			const result = resolvePipelineOwnerCwds(pipeline, new Map(), new Map());
			expect(result).toEqual({ ok: false, reason: 'no-bindings' });
		});

		it("returns 'unresolved' when no agent resolves to a session with a projectRoot", () => {
			const pipeline = makePipeline([{ sessionId: 'missing', sessionName: 'gone' }]);
			const result = resolvePipelineOwnerCwds(pipeline, new Map(), new Map());
			expect(result).toEqual({ ok: false, reason: 'unresolved' });
		});

		it("returns 'unresolved' when ANY agent is unresolvable (atomic save semantics)", () => {
			// We surface this as a per-pipeline error rather than silently
			// dropping the unresolvable agent's contribution - the user needs
			// to either fix the dangling reference or explicitly remove the
			// node.
			const pipeline = makePipeline([
				{ sessionId: 's1', sessionName: 'alpha' },
				{ sessionId: 'missing', sessionName: 'gone' },
			]);
			const byId = mapBy<SessionRootInfo>([['s1', { projectRoot: '/workspace/proj' }]]);
			const result = resolvePipelineOwnerCwds(pipeline, byId, new Map());
			expect(result).toEqual({ ok: false, reason: 'unresolved' });
		});

		it("returns 'unresolved' when projectRoot is undefined on the resolved session", () => {
			const pipeline = makePipeline([{ sessionId: 's1', sessionName: 'alpha' }]);
			const byId = mapBy<SessionRootInfo>([['s1', { projectRoot: undefined }]]);
			const result = resolvePipelineOwnerCwds(pipeline, byId, new Map());
			expect(result).toEqual({ ok: false, reason: 'unresolved' });
		});

		it('treats empty-string sessionId/sessionName as unresolvable (defensive guard)', () => {
			const pipeline = makePipeline([{ sessionId: '', sessionName: '' }]);
			const byId = mapBy<SessionRootInfo>([['', { projectRoot: '/should-not-match' }]]);
			const byName = mapBy<SessionRootInfo>([['', { projectRoot: '/also-should-not-match' }]]);
			const result = resolvePipelineOwnerCwds(pipeline, byId, byName);
			expect(result).toEqual({ ok: false, reason: 'unresolved' });
		});
	});

	describe('command-node-only pipelines', () => {
		it("resolves the cwd from the command's owning session", () => {
			const pipeline = makeCommandOnlyPipeline([
				{ id: 'cmd-1', owningSessionId: 's-cyber', owningSessionName: 'Cyber Stocks' },
			]);
			const byId = mapBy<SessionRootInfo>([
				['s-cyber', { projectRoot: '/Users/me/Projects/Cyber-Stocks' }],
			]);
			const result = resolvePipelineOwnerCwds(pipeline, byId, new Map());
			expect(result).toEqual({
				ok: true,
				cwds: new Set(['/Users/me/Projects/Cyber-Stocks']),
			});
		});

		it('falls back to owningSessionName when owningSessionId is missing', () => {
			const pipeline = makeCommandOnlyPipeline([
				{ id: 'cmd-1', owningSessionId: 'missing', owningSessionName: 'Cyber Stocks' },
			]);
			const byName = mapBy<SessionRootInfo>([
				['Cyber Stocks', { projectRoot: '/Users/me/Projects/Cyber-Stocks' }],
			]);
			const result = resolvePipelineOwnerCwds(pipeline, new Map(), byName);
			expect(result).toEqual({
				ok: true,
				cwds: new Set(['/Users/me/Projects/Cyber-Stocks']),
			});
		});

		it('returns every distinct cwd for sibling commands across cwds (no common-ancestor collapse)', () => {
			const pipeline = makeCommandOnlyPipeline([
				{ id: 'cmd-1', owningSessionId: 's1', owningSessionName: 'A' },
				{ id: 'cmd-2', owningSessionId: 's2', owningSessionName: 'B' },
			]);
			const byId = mapBy<SessionRootInfo>([
				['s1', { projectRoot: '/project/A' }],
				['s2', { projectRoot: '/project/B' }],
			]);
			const result = resolvePipelineOwnerCwds(pipeline, byId, new Map());
			expect(result).toEqual({
				ok: true,
				cwds: new Set(['/project/A', '/project/B']),
			});
		});

		it("returns 'no-bindings' when the only command has no owning-session binding", () => {
			// An in-flight command with no owning-session set yet is unbound;
			// no agent or command contributes a cwd.
			const pipeline = makeCommandOnlyPipeline([
				{ id: 'cmd-1', owningSessionId: '', owningSessionName: '' },
			]);
			const result = resolvePipelineOwnerCwds(pipeline, new Map(), new Map());
			expect(result).toEqual({ ok: false, reason: 'no-bindings' });
		});

		it("returns 'unresolved' when the command's owning session has no projectRoot", () => {
			const pipeline = makeCommandOnlyPipeline([
				{ id: 'cmd-1', owningSessionId: 's-cyber', owningSessionName: 'Cyber Stocks' },
			]);
			const byId = mapBy<SessionRootInfo>([['s-cyber', { projectRoot: undefined }]]);
			const result = resolvePipelineOwnerCwds(pipeline, byId, new Map());
			expect(result).toEqual({ ok: false, reason: 'unresolved' });
		});

		it('returns the union of agent + command cwds when both are present', () => {
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
			const result = resolvePipelineOwnerCwds(pipeline, byId, new Map());
			expect(result).toEqual({
				ok: true,
				cwds: new Set(['/project/agent', '/project/cmd']),
			});
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

	it('skips pipelines that fail to resolve', () => {
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

	it('returns every per-agent cwd (no common-ancestor collapse)', () => {
		// The pre-architecture-change model returned the common ancestor
		// (e.g. '/project') as the single write root. The per-agent-cwd
		// model returns each owning agent's cwd; the common ancestor never
		// appears because no yaml ever lives there.
		const pipeline = makePipeline([
			{ sessionId: 's1', sessionName: 'frontend' },
			{ sessionId: 's2', sessionName: 'digest' },
		]);
		const byId = mapBy<SessionRootInfo>([
			['s1', { projectRoot: '/project/frontend' }],
			['s2', { projectRoot: '/project/Digest' }],
		]);
		const roots = resolvePipelinesWriteRoots([pipeline], byId, new Map());
		expect(roots).toEqual(new Set(['/project/frontend', '/project/Digest']));
		expect(roots.has('/project')).toBe(false);
	});
});
