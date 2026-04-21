/**
 * Tests for the session runtime's ancestor-cue.yaml fallback on init.
 *
 * Pipelines saved to a common-ancestor root need to be visible to each
 * sub-agent that participates in them, even though the sub-agent's own
 * project directory doesn't have a cue.yaml of its own — OR has an empty
 * `subscriptions: []` cue.yaml written by `handleSave` when it cleared
 * that project's previous pipelines.
 *
 * These tests exercise both "no file" and "empty file" branches so the
 * empty-file regression (trigger/command nodes load, but runtime shows
 * 0 subs for sub-agents, so manual trigger dispatches nothing) stays
 * fixed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CueConfig } from '../../../main/cue/cue-types';
import type { SessionInfo } from '../../../shared/types';

type DetailedResult =
	| { ok: true; config: CueConfig; warnings: string[] }
	| { ok: false; reason: 'missing' }
	| { ok: false; reason: 'parse-error'; message: string }
	| { ok: false; reason: 'invalid'; errors: string[] };

// Per-projectRoot loader lookup. Each test seeds this map with the configs
// it wants returned for specific paths so the ancestor walk can be
// exercised deterministically.
const loaderByPath = new Map<string, DetailedResult>();
const ancestorLookup = new Map<string, string | null>();

const mockWatchCueYaml = vi.fn<(projectRoot: string, onChange: () => void) => () => void>();

vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfig: (projectRoot: string) => {
		const result = loaderByPath.get(projectRoot);
		return result && result.ok ? result.config : null;
	},
	loadCueConfigDetailed: (projectRoot: string) =>
		loaderByPath.get(projectRoot) ?? { ok: false as const, reason: 'missing' as const },
	watchCueYaml: (...args: unknown[]) => mockWatchCueYaml(args[0] as string, args[1] as () => void),
	findAncestorCueConfigRoot: (projectRoot: string) => ancestorLookup.get(projectRoot) ?? null,
}));

vi.mock('../../../main/cue/cue-file-watcher', () => ({
	createCueFileWatcher: () => vi.fn(),
}));

vi.mock('../../../main/cue/cue-db', () => ({
	initCueDb: vi.fn(),
	closeCueDb: vi.fn(),
	updateHeartbeat: vi.fn(),
	getLastHeartbeat: vi.fn(() => null),
	pruneCueEvents: vi.fn(),
	recordCueEvent: vi.fn(),
	updateCueEventStatus: vi.fn(),
	safeRecordCueEvent: vi.fn(),
	safeUpdateCueEventStatus: vi.fn(),
	clearGitHubSeenForSubscription: vi.fn(),
}));

vi.mock('../../../main/cue/cue-reconciler', () => ({
	reconcileMissedTimeEvents: vi.fn(),
}));

vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => `uuid-${Math.random().toString(36).slice(2, 8)}`),
}));

import { CueEngine, type CueEngineDeps } from '../../../main/cue/cue-engine';

const ANCESTOR_ROOT = '/home/user/project';
const AGENT1_ROOT = '/home/user/project/agent1';
const AGENT2_ROOT = '/home/user/project/agent2';

const SESSION_MAIN: SessionInfo = {
	id: 'session-main',
	name: 'Main',
	toolType: 'claude-code',
	cwd: ANCESTOR_ROOT,
	projectRoot: ANCESTOR_ROOT,
};
const SESSION_AGENT_1: SessionInfo = {
	id: 'session-a1',
	name: 'Agent 1',
	toolType: 'claude-code',
	cwd: AGENT1_ROOT,
	projectRoot: AGENT1_ROOT,
};
const SESSION_AGENT_2: SessionInfo = {
	id: 'session-a2',
	name: 'Agent 2',
	toolType: 'claude-code',
	cwd: AGENT2_ROOT,
	projectRoot: AGENT2_ROOT,
};

function makeDeps(sessions: SessionInfo[]): CueEngineDeps {
	return {
		getSessions: () => sessions,
		onCueRun: vi.fn(async (_request: Parameters<CueEngineDeps['onCueRun']>[0]) => ({
			runId: 'run-1',
			sessionId: sessions[0].id,
			sessionName: sessions[0].name,
			subscriptionName: 'unused',
			event: { id: 'e', type: 'cli.trigger', timestamp: '', triggerName: '', payload: {} },
			status: 'completed' as const,
			stdout: '',
			stderr: '',
			exitCode: 0,
			durationMs: 0,
			startedAt: '',
			endedAt: '',
		})),
		onStopCueRun: vi.fn(() => true),
		onLog: vi.fn(),
	};
}

function ancestorConfigWithSubsForBothAgents(): CueConfig {
	return {
		subscriptions: [
			{
				name: 'Pipeline 1-cmd-a',
				event: 'time.scheduled',
				enabled: true,
				prompt: './script1.sh',
				action: 'command',
				command: { mode: 'shell', shell: './script1.sh' },
				schedule_times: ['07:00'],
				agent_id: SESSION_AGENT_1.id,
				pipeline_name: 'Pipeline 1',
			},
			{
				name: 'Pipeline 1-cmd-b',
				event: 'time.scheduled',
				enabled: true,
				prompt: './script2.sh',
				action: 'command',
				command: { mode: 'shell', shell: './script2.sh' },
				schedule_times: ['07:00'],
				agent_id: SESSION_AGENT_2.id,
				pipeline_name: 'Pipeline 1',
			},
			{
				name: 'Pipeline 1-chain-main',
				event: 'agent.completed',
				enabled: true,
				prompt: 'aggregate',
				source_session: ['Agent 1', 'Agent 2'],
				agent_id: SESSION_MAIN.id,
				pipeline_name: 'Pipeline 1',
			},
		],
		settings: {
			timeout_minutes: 30,
			timeout_on_fail: 'break',
			max_concurrent: 4,
			queue_size: 10,
		},
	};
}

describe('ancestor cue.yaml fallback', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		loaderByPath.clear();
		ancestorLookup.clear();
		mockWatchCueYaml.mockReturnValue(vi.fn());
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('walks to ancestor when the session has no local cue.yaml', () => {
		// Agent dirs have NO cue.yaml. Ancestor has the pipeline with subs
		// targeting both agents.
		loaderByPath.set(ANCESTOR_ROOT, {
			ok: true,
			config: ancestorConfigWithSubsForBothAgents(),
			warnings: [],
		});
		ancestorLookup.set(AGENT1_ROOT, ANCESTOR_ROOT);
		ancestorLookup.set(AGENT2_ROOT, ANCESTOR_ROOT);

		const deps = makeDeps([SESSION_MAIN, SESSION_AGENT_1, SESSION_AGENT_2]);
		const engine = new CueEngine(deps);
		engine.start();

		// Each agent session should see ONE targeted subscription from the
		// ancestor config (the command sub addressed to its id).
		const graph = engine.getGraphData();
		const agent1View = graph.find((g) => g.sessionId === SESSION_AGENT_1.id);
		const agent2View = graph.find((g) => g.sessionId === SESSION_AGENT_2.id);
		expect(agent1View?.subscriptions.map((s) => s.name)).toEqual(['Pipeline 1-cmd-a']);
		expect(agent2View?.subscriptions.map((s) => s.name)).toEqual(['Pipeline 1-cmd-b']);

		engine.stop();
	});

	it('walks to ancestor when the session has an empty local cue.yaml', () => {
		// Agent dirs have `subscriptions: []` (the shape `handleSave` writes
		// when it clears a previously-written root whose pipelines have
		// moved to a common ancestor). Before the fix, the empty-but-
		// parseable file short-circuited the ancestor walk and every
		// sub-agent registered 0 subscriptions — manual triggers on the
		// parent pipeline dispatched nothing, and per-agent commands
		// silently never armed.
		const emptyConfig: CueConfig = {
			subscriptions: [],
			settings: {
				timeout_minutes: 30,
				timeout_on_fail: 'break',
				max_concurrent: 1,
				queue_size: 10,
			},
		};
		loaderByPath.set(AGENT1_ROOT, { ok: true, config: emptyConfig, warnings: [] });
		loaderByPath.set(AGENT2_ROOT, { ok: true, config: emptyConfig, warnings: [] });
		loaderByPath.set(ANCESTOR_ROOT, {
			ok: true,
			config: ancestorConfigWithSubsForBothAgents(),
			warnings: [],
		});
		ancestorLookup.set(AGENT1_ROOT, ANCESTOR_ROOT);
		ancestorLookup.set(AGENT2_ROOT, ANCESTOR_ROOT);

		const deps = makeDeps([SESSION_MAIN, SESSION_AGENT_1, SESSION_AGENT_2]);
		const engine = new CueEngine(deps);
		engine.start();

		const graph = engine.getGraphData();
		const agent1View = graph.find((g) => g.sessionId === SESSION_AGENT_1.id);
		const agent2View = graph.find((g) => g.sessionId === SESSION_AGENT_2.id);
		// Both sub-agents see their targeted command sub from the ancestor,
		// not the empty local file.
		expect(agent1View?.subscriptions.map((s) => s.name)).toEqual(['Pipeline 1-cmd-a']);
		expect(agent2View?.subscriptions.map((s) => s.name)).toEqual(['Pipeline 1-cmd-b']);

		engine.stop();
	});

	it('keeps the local config when it has its own subscriptions (no ancestor takeover)', () => {
		// The ancestor fallback is an addition, not a replacement. A local
		// file with real subs must win over the ancestor to avoid silently
		// mixing two unrelated pipelines.
		const localConfig: CueConfig = {
			subscriptions: [
				{
					name: 'local-only',
					event: 'cli.trigger',
					enabled: true,
					prompt: 'local work',
				},
			],
			settings: {
				timeout_minutes: 30,
				timeout_on_fail: 'break',
				max_concurrent: 1,
				queue_size: 10,
			},
		};
		loaderByPath.set(AGENT1_ROOT, { ok: true, config: localConfig, warnings: [] });
		loaderByPath.set(ANCESTOR_ROOT, {
			ok: true,
			config: ancestorConfigWithSubsForBothAgents(),
			warnings: [],
		});
		ancestorLookup.set(AGENT1_ROOT, ANCESTOR_ROOT);

		const deps = makeDeps([SESSION_AGENT_1]);
		const engine = new CueEngine(deps);
		engine.start();

		const graph = engine.getGraphData();
		const agent1View = graph.find((g) => g.sessionId === SESSION_AGENT_1.id);
		expect(agent1View?.subscriptions.map((s) => s.name)).toEqual(['local-only']);

		engine.stop();
	});

	it('stays empty when local and ancestor both have nothing targeting the session', () => {
		// Empty local + ancestor exists but targets no sub at this session
		// → session simply has 0 subs. Fallback must not invent subs.
		const emptyConfig: CueConfig = {
			subscriptions: [],
			settings: {
				timeout_minutes: 30,
				timeout_on_fail: 'break',
				max_concurrent: 1,
				queue_size: 10,
			},
		};
		const ancestorUnrelated: CueConfig = {
			subscriptions: [
				{
					name: 'for-someone-else',
					event: 'cli.trigger',
					enabled: true,
					prompt: 'x',
					agent_id: 'session-unrelated',
				},
			],
			settings: {
				timeout_minutes: 30,
				timeout_on_fail: 'break',
				max_concurrent: 1,
				queue_size: 10,
			},
		};
		loaderByPath.set(AGENT1_ROOT, { ok: true, config: emptyConfig, warnings: [] });
		loaderByPath.set(ANCESTOR_ROOT, {
			ok: true,
			config: ancestorUnrelated,
			warnings: [],
		});
		ancestorLookup.set(AGENT1_ROOT, ANCESTOR_ROOT);

		const deps = makeDeps([SESSION_AGENT_1]);
		const engine = new CueEngine(deps);
		engine.start();

		const graph = engine.getGraphData();
		const agent1View = graph.find((g) => g.sessionId === SESSION_AGENT_1.id);
		expect(agent1View?.subscriptions).toEqual([]);

		engine.stop();
	});
});
