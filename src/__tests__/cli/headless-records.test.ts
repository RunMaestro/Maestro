/**
 * A headless run leaves its records in the data dir it ran against.
 *
 * The data dir here is provisioned the way a server's is: a source dir is
 * exported with the real bundle exporter and imported into an empty dir with
 * the real importer, and MAESTRO_USER_DATA points at the result. The agent
 * itself is mocked (the live runs with Claude Code and OpenCode are recorded in
 * docs/agent-guides/CLI-HEADLESS.md); it ticks the first open checkbox in the
 * Auto Run documents and reports token usage, like a provider would.
 *
 * What this proves, per verb: the ledger run lands in the data dir and carries
 * the turn's usage, history lands there (for the verbs that write it), the CLI
 * activity marker is cleared, and nothing is written outside the scratch root.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const usageStats = {
	inputTokens: 100,
	outputTokens: 20,
	cacheReadInputTokens: 0,
	cacheCreationInputTokens: 0,
	totalCostUsd: 0.001,
	contextWindow: 200000,
};

const agentState = vi.hoisted(() => ({ workspace: '', turns: 0 }));

vi.mock('../../cli/services/agent-spawner', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../cli/services/agent-spawner')>();
	const nodeFs = require('fs') as typeof import('fs');
	const nodePath = require('path') as typeof import('path');
	/** Do the work a real agent would: tick the first open task in the Auto Run docs. */
	function tickOneTask(): void {
		const folder = nodePath.join(agentState.workspace, '.maestro', 'playbooks');
		if (!nodeFs.existsSync(folder)) return;
		for (const name of nodeFs
			.readdirSync(folder)
			.filter((n) => n.endsWith('.md'))
			.sort()) {
			const file = nodePath.join(folder, name);
			const text = nodeFs.readFileSync(file, 'utf-8');
			if (text.includes('- [ ]')) {
				nodeFs.writeFileSync(file, text.replace('- [ ]', '- [x]'));
				return;
			}
		}
	}
	return {
		...actual,
		detectAgent: vi.fn(async () => ({ available: true, path: '/usr/bin/true', source: 'path' })),
		spawnAgent: vi.fn(async (_tool: string, _cwd: string, _prompt: string, sessionId?: string) => {
			agentState.turns += 1;
			tickOneTask();
			return {
				success: true,
				outcome: 'completed',
				response: 'Done.',
				agentSessionId: sessionId ?? `provider-session-${agentState.turns}`,
				usageStats: {
					inputTokens: 100,
					outputTokens: 20,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0.001,
					contextWindow: 200000,
				},
			};
		}),
	};
});

import { exportCueBundle } from '../../main/cue/bundle/cue-bundle-exporter';
import { importCueBundle } from '../../main/cue/bundle/cue-bundle-importer';
import { send } from '../../cli/commands/send';
import { runDoc } from '../../cli/commands/run-doc';
import { runPlaybook } from '../../cli/commands/run-playbook';
import { goalRun } from '../../cli/commands/goal-run';
import { readAgentRuns } from '../../cli/services/agent-run-store';
import { readHistory, readSessions } from '../../cli/services/storage';

const AGENT_ID = 'agent-headless';

let root: string;
let dataDir: string;
let savedUserData: string | undefined;
let logSpy: MockInstance;
let exitSpy: MockInstance;

/** Every file under `dir`, relative, for "nothing written outside the scratch root". */
function snapshotOutside(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return (fs.readdirSync(dir, { recursive: true }) as string[]).sort();
}

function resetDoc(): void {
	fs.writeFileSync(
		path.join(agentState.workspace, '.maestro', 'playbooks', 'task.md'),
		'# Task\n\n- [ ] first\n- [ ] second\n'
	);
}

beforeAll(async () => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-headless-')));

	// The exporting machine: one agent with an Auto Run folder and a playbook.
	const srcData = path.join(root, 'src-data');
	const srcWork = path.join(root, 'src-work', 'proj');
	fs.mkdirSync(path.join(srcWork, '.maestro', 'playbooks'), { recursive: true });
	fs.writeFileSync(
		path.join(srcWork, '.maestro', 'playbooks', 'task.md'),
		'# Task\n\n- [ ] first\n'
	);
	fs.mkdirSync(path.join(srcData, 'playbooks'), { recursive: true });
	fs.writeFileSync(
		path.join(srcData, 'maestro-sessions.json'),
		JSON.stringify({
			sessions: [
				{
					id: AGENT_ID,
					name: 'Headless',
					toolType: 'claude-code',
					cwd: srcWork,
					fullPath: srcWork,
					projectRoot: srcWork,
					autoRunFolderPath: path.join(srcWork, '.maestro', 'playbooks'),
				},
			],
		})
	);
	fs.writeFileSync(
		path.join(srcData, 'playbooks', `${AGENT_ID}.json`),
		JSON.stringify({
			playbooks: [
				{
					id: 'pb-headless',
					name: 'Smoke',
					createdAt: 1,
					updatedAt: 1,
					documents: [{ filename: 'task', resetOnCompletion: false }],
					loopEnabled: false,
					prompt: '',
				},
			],
		})
	);

	const bundle = path.join(root, 'agent.zip');
	const exported = await exportCueBundle({
		dataDir: srcData,
		agentId: AGENT_ID,
		outputPath: bundle,
		producerVersion: '0.0.0',
	});

	// The server: an empty data dir and a fresh workspace, provisioned by import.
	dataDir = path.join(root, 'server-data');
	agentState.workspace = path.join(root, 'server-work', 'proj');
	fs.mkdirSync(agentState.workspace, { recursive: true });
	await importCueBundle({
		bundlePath: bundle,
		dataDir,
		workspaces: { [exported.manifest.workspaces[0].key]: agentState.workspace },
		runningVersion: '99.0.0',
	});

	savedUserData = process.env.MAESTRO_USER_DATA;
	process.env.MAESTRO_USER_DATA = dataDir;
});

afterAll(() => {
	if (savedUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = savedUserData;
	fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
		throw new Error(`unexpected exit ${code}`);
	});
	resetDoc();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function runsFrom(source: string) {
	return readAgentRuns().filter((run) => run.source === source);
}

function expectNoActiveCliRun(): void {
	const file = path.join(dataDir, 'cli-activity.json');
	if (!fs.existsSync(file)) return;
	expect(JSON.parse(fs.readFileSync(file, 'utf-8')).activities).toEqual([]);
}

describe('headless records land in the imported data dir', () => {
	it('provisions the agent and its playbook from the bundle', () => {
		expect(readSessions().map((s) => s.id)).toEqual([AGENT_ID]);
		expect(fs.existsSync(path.join(dataDir, 'playbooks', `${AGENT_ID}.json`))).toBe(true);
	});

	it('send: a new turn and a resumed one each leave a ledger run with usage', async () => {
		await send(AGENT_ID, 'Say hi', {});
		const first = JSON.parse(String(logSpy.mock.calls[0][0]));
		expect(first.success).toBe(true);

		await send(AGENT_ID, 'Say it again', { session: first.sessionId });

		const runs = runsFrom('cli:send');
		expect(runs).toHaveLength(2);
		expect(runs.every((run) => run.status === 'completed')).toBe(true);
		expect(runs.map((run) => run.usage)).toEqual([usageStats, usageStats]);
		// A new turn is filed under the agent; a resumed one under its provider session.
		expect(runs.map((run) => run.sessionId).sort()).toEqual([AGENT_ID, first.sessionId].sort());
		expect(fs.existsSync(path.join(dataDir, 'maestro-agent-runs.json'))).toBe(true);
	});

	it('run-doc: checks the document off and records history and ledger runs', async () => {
		await runDoc(['task.md'], { agent: AGENT_ID, json: true, synopsis: false } as never);

		expect(exitSpy).not.toHaveBeenCalled();
		const doc = fs.readFileSync(
			path.join(agentState.workspace, '.maestro', 'playbooks', 'task.md'),
			'utf-8'
		);
		expect(doc).not.toContain('- [ ]');
		const runs = runsFrom('cli:autorun');
		expect(runs.length).toBeGreaterThan(0);
		expect(runs.every((run) => run.usage)).toBe(true);
		expect(readHistory(undefined, AGENT_ID).length).toBeGreaterThan(0);
		expectNoActiveCliRun();
	});

	it('playbook: runs the imported playbook', async () => {
		const before = runsFrom('cli:autorun').length;
		await runPlaybook('pb-headless', { json: true, synopsis: false } as never);

		expect(exitSpy).not.toHaveBeenCalled();
		expect(runsFrom('cli:autorun').length).toBeGreaterThan(before);
		expectNoActiveCliRun();
	});

	it('goal-run: an iteration lands in the ledger and history', async () => {
		const historyBefore = readHistory(undefined, AGENT_ID).length;
		await goalRun(AGENT_ID, 'Tick the boxes', { maxIterations: '1', json: true } as never);

		expect(exitSpy).not.toHaveBeenCalled();
		const runs = readAgentRuns().filter((run) => run.source?.startsWith('cli:goal'));
		expect(runs.length).toBeGreaterThan(0);
		expect(runs.every((run) => run.usage)).toBe(true);
		expect(readHistory(undefined, AGENT_ID).length).toBeGreaterThan(historyBefore);
		expectNoActiveCliRun();
	});

	it('writes nothing outside the scratch root', () => {
		// The platform default data dirs this test must never touch, resolved the
		// way the CLI would without MAESTRO_USER_DATA.
		const configRoot = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
		for (const name of ['Maestro', 'maestro', 'maestro-dev']) {
			const dir = path.join(configRoot, name);
			const runsFile = path.join(dir, 'maestro-agent-runs.json');
			if (!fs.existsSync(runsFile)) continue;
			expect(
				readAgentRunsFile(runsFile).some((run) => String(run.cwd ?? '').startsWith(root))
			).toBe(false);
		}
		expect(snapshotOutside(dataDir).length).toBeGreaterThan(0);
	});
});

function readAgentRunsFile(file: string): Array<{ cwd?: string }> {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
		return Array.isArray(parsed) ? parsed : (parsed.runs ?? []);
	} catch {
		return [];
	}
}
