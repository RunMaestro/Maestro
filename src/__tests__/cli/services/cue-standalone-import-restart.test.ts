/**
 * A server picks up what a bundle import changed at its next start.
 *
 * Import refuses while an engine holds the data directory (ENGINE_RUNNING), so
 * the flow is restart-based: stop, import, start. Everything here is real
 * except the agent executors and `cue.db` (the in-memory mirror, since the
 * native module is built for Electron): the bundle exporter and importer, the
 * engine lock file, `maestro-sessions.json` read by the standalone engine's
 * own deps, and the cue.yaml loader.
 *
 * - Added: an agent imported while the engine is stopped is armed at start.
 * - Removed: an agent taken out of `maestro-sessions.json` is not initialized,
 *   and a forced re-import that moves an agent to another workspace leaves
 *   the old workspace's subscriptions behind. Queue rows for either are
 *   dropped (recorded, never run), and fan-in progress owned by the removed
 *   agent is discarded.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	createInMemoryCueDb,
	buildCueDbModuleMock,
	type InMemoryCueDb,
} from '../../main/cue/cue-integration-test-helpers';

let sharedDb: InMemoryCueDb | null = null;
function getSharedDb(): InMemoryCueDb {
	if (!sharedDb) sharedDb = createInMemoryCueDb();
	return sharedDb;
}

const executeCuePrompt = vi.fn();
vi.mock('../../../main/cue/cue-db', () => buildCueDbModuleMock(() => getSharedDb()));
vi.mock('../../../shared/maestro-lib/parsers', () => ({ initializeOutputParsers: vi.fn() }));
vi.mock('../../../main/cue/cue-executor', () => ({ executeCuePrompt, stopCueRun: vi.fn() }));
vi.mock('../../../main/cue/cue-shell-executor', () => ({
	executeCueShell: vi.fn(),
	stopCueShellRun: vi.fn(),
}));
vi.mock('../../../main/cue/cue-cli-executor', () => ({
	executeCueCli: vi.fn(),
	stopCueCliRun: vi.fn(),
}));
vi.mock('../../../main/cue/cue-notify-executor', () => ({ executeCueNotify: vi.fn() }));

import { exportCueBundle } from '../../../main/cue/bundle/cue-bundle-exporter';
import {
	importCueBundle,
	CueBundleImportError,
} from '../../../main/cue/bundle/cue-bundle-importer';
import { createStandaloneCueEngine } from '../../../cli/services/cue-standalone-engine';
import type { CueEngine } from '../../../main/cue/cue-engine';
import type { CueEvent } from '../../../main/cue/cue-types';

const ALPHA = 'agent-alpha';
const BETA = 'agent-beta';

let root: string;
let srcData: string;
let dataDir: string;
let savedUserData: string | undefined;
let engine: CueEngine | null = null;
let logLines: Array<[string, string]>;

function cueYaml(subscriptionName: string): string {
	return [
		'subscriptions:',
		`  - name: ${subscriptionName}`,
		'    event: time.scheduled',
		'    schedule_times: ["03:00"]',
		`    prompt: Run ${subscriptionName}`,
		'',
	].join('\n');
}

/** A source machine's agent: a workspace with a cue.yaml, and its session record. */
function sourceAgent(id: string, name: string, subscriptionName: string) {
	const work = path.join(root, 'src-work', name);
	fs.mkdirSync(path.join(work, '.maestro'), { recursive: true });
	fs.writeFileSync(path.join(work, '.maestro', 'cue.yaml'), cueYaml(subscriptionName));
	return { id, name, toolType: 'claude-code', cwd: work, fullPath: work, projectRoot: work };
}

async function exportAgent(agentId: string): Promise<{ bundle: string; workspaceKey: string }> {
	const bundle = path.join(root, `${agentId}.zip`);
	const exported = await exportCueBundle({
		dataDir: srcData,
		agentId,
		outputPath: bundle,
		producerVersion: '0.0.0',
	});
	return { bundle, workspaceKey: exported.manifest.workspaces[0].key };
}

async function importAgent(agentId: string, workspace: string, force = false): Promise<void> {
	const { bundle, workspaceKey } = await exportAgent(agentId);
	fs.mkdirSync(workspace, { recursive: true });
	await importCueBundle({
		bundlePath: bundle,
		dataDir,
		workspaces: { [workspaceKey]: workspace },
		runningVersion: '99.0.0',
		force,
	});
}

async function startEngine(): Promise<CueEngine> {
	engine = await createStandaloneCueEngine({
		onLog: (level, message) => logLines.push([level, message]),
	});
	engine.start();
	return engine;
}

function stopEngine(): void {
	engine?.stop();
	engine = null;
}

/** Subscription names per armed (registered) agent. */
function armed(running: CueEngine): Record<string, string[]> {
	const enabled = new Set(
		running
			.getStatus()
			.filter((s) => s.enabled)
			.map((s) => s.sessionId)
	);
	return Object.fromEntries(
		running
			.getGraphData()
			.filter((s) => enabled.has(s.sessionId))
			.map((s) => [s.sessionId, s.subscriptions.map((sub) => sub.name)])
	);
}

function queueRow(id: string, sessionId: string, subscriptionName: string) {
	const event: CueEvent = {
		id: `evt-${id}`,
		type: 'time.scheduled',
		timestamp: new Date().toISOString(),
		triggerName: subscriptionName,
		payload: {},
	};
	return {
		id,
		sessionId,
		subscriptionName,
		eventJson: JSON.stringify(event),
		prompt: `Run ${subscriptionName}`,
		outputPrompt: null,
		cliOutputJson: null,
		action: null,
		commandJson: null,
		chainDepth: 0,
		queuedAt: Date.now(),
		chainRootId: null,
		parentEventId: null,
	};
}

function readSessionsFile(): { sessions: Array<{ id: string; projectRoot: string }> } {
	return JSON.parse(fs.readFileSync(path.join(dataDir, 'maestro-sessions.json'), 'utf-8'));
}

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-import-restart-')));
	srcData = path.join(root, 'src-data');
	dataDir = path.join(root, 'server-data');
	fs.mkdirSync(srcData, { recursive: true });
	fs.writeFileSync(
		path.join(srcData, 'maestro-sessions.json'),
		JSON.stringify({
			sessions: [
				sourceAgent(ALPHA, 'Alpha', 'alpha-nightly'),
				sourceAgent(BETA, 'Beta', 'beta-nightly'),
			],
		})
	);
	savedUserData = process.env.MAESTRO_USER_DATA;
	process.env.MAESTRO_USER_DATA = dataDir;
	sharedDb = createInMemoryCueDb();
	logLines = [];
	executeCuePrompt.mockReset();
	executeCuePrompt.mockResolvedValue({ status: 'completed' });
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	stopEngine();
	vi.restoreAllMocks();
	if (savedUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = savedUserData;
	fs.rmSync(root, { recursive: true, force: true });
});

describe('standalone engine and bundle import: restart picks up the change', () => {
	it('arms an agent and its subscription imported while the engine was stopped', async () => {
		await importAgent(ALPHA, path.join(root, 'server-work', 'alpha'));
		const first = await startEngine();
		expect(armed(first)).toEqual({ [ALPHA]: ['alpha-nightly'] });

		// Import refuses while this engine holds the data directory.
		await expect(importAgent(BETA, path.join(root, 'server-work', 'beta'))).rejects.toMatchObject({
			code: 'ENGINE_RUNNING',
		} satisfies Partial<CueBundleImportError>);

		stopEngine();
		await importAgent(BETA, path.join(root, 'server-work', 'beta'));
		const second = await startEngine();

		expect(armed(second)).toEqual({
			[ALPHA]: ['alpha-nightly'],
			[BETA]: ['beta-nightly'],
		});
	});

	it('drops what belonged to a removed agent or a subscription a re-import left behind', async () => {
		const alphaOld = path.join(root, 'server-work', 'alpha-old');
		const alphaNew = path.join(root, 'server-work', 'alpha-new');
		await importAgent(ALPHA, alphaOld);
		await importAgent(BETA, path.join(root, 'server-work', 'beta'));
		// An operator added a subscription by hand in Alpha's first workspace.
		fs.appendFileSync(
			path.join(alphaOld, '.maestro', 'cue.yaml'),
			cueYaml('alpha-local').replace('subscriptions:\n', '')
		);
		const first = await startEngine();
		expect(armed(first)).toEqual({
			[ALPHA]: ['alpha-nightly', 'alpha-local'],
			[BETA]: ['beta-nightly'],
		});
		stopEngine();

		// What the stopped engine left on disk.
		const db = getSharedDb();
		db.initCueDb();
		db.persistQueuedEvent(queueRow('q-beta', BETA, 'beta-nightly'));
		db.persistQueuedEvent(queueRow('q-alpha-local', ALPHA, 'alpha-local'));
		db.persistQueuedEvent(queueRow('q-alpha-nightly', ALPHA, 'alpha-nightly'));
		db.persistFanInSource({
			ownerSessionId: BETA,
			subscriptionName: 'beta-join',
			sourceSessionId: ALPHA,
			sourceSessionName: 'Alpha',
			output: 'done',
			truncated: false,
			chainDepth: 0,
			startedAt: Date.now(),
			completedAt: Date.now(),
		});

		// Beta is removed from the data dir; a forced re-import moves Alpha.
		const sessionsFile = readSessionsFile();
		sessionsFile.sessions = sessionsFile.sessions.filter((s) => s.id !== BETA);
		fs.writeFileSync(path.join(dataDir, 'maestro-sessions.json'), JSON.stringify(sessionsFile));
		await importAgent(ALPHA, alphaNew, true);
		expect(readSessionsFile().sessions.find((s) => s.id === ALPHA)?.projectRoot).toBe(alphaNew);

		const second = await startEngine();

		expect(armed(second)).toEqual({ [ALPHA]: ['alpha-nightly'] });
		// Only the row whose agent and subscription still exist ran.
		await vi.waitFor(() => expect(executeCuePrompt).toHaveBeenCalledTimes(1));
		expect(executeCuePrompt.mock.calls[0][0]).toMatchObject({
			session: { id: ALPHA },
			event: { triggerName: 'alpha-nightly' },
			// In the workspace the re-import moved it to.
			projectRoot: alphaNew,
		});
		expect(db.getQueuedEvents().map((row) => row.id)).not.toContain('q-beta');
		expect(db.getQueuedEvents().map((row) => row.id)).not.toContain('q-alpha-local');
		expect(db.getFanInState()).toEqual([]);

		const warnings = logLines.filter(([level]) => level === 'warn').map(([, m]) => m);
		expect(warnings).toEqual(
			expect.arrayContaining([
				expect.stringContaining('1 persisted queue row(s) whose session is no longer registered'),
				expect.stringContaining(
					"1 persisted queue row(s) whose subscription is no longer in any agent's config"
				),
				expect.stringContaining('Dropped saved fan-in progress for "beta-join"'),
			])
		);
		// Each drop is recorded in the history, never as a run.
		const drops = db
			.getRecentCueEvents(0)
			.filter((e) => e.type === 'restored')
			.map((e) => [e.subscriptionName, JSON.parse(e.payload ?? '{}').reason]);
		expect(drops).toEqual(
			expect.arrayContaining([
				['beta-nightly', 'session-missing'],
				['alpha-local', 'subscription-missing'],
			])
		);
	});
});
