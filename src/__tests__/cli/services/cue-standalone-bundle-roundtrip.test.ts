// Source: src/__tests__/cli/services/cue-standalone-import-restart.test.ts
// Source: src/__tests__/main/cue/bundle/cue-bundle-claude-roundtrip.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createInMemoryCueDb } from '../../main/cue/cue-integration-test-helpers';
import { buildCueDbModuleMock } from '../../main/cue/cue-integration-test-helpers';
import type { InMemoryCueDb } from '../../main/cue/cue-integration-test-helpers';
import { exportCueBundle } from '../../../main/cue/bundle/cue-bundle-exporter';
import { importCueBundle } from '../../../main/cue/bundle/cue-bundle-importer';
import { CueBundleImportError } from '../../../main/cue/bundle/cue-bundle-importer';
import { createStandaloneCueEngine } from '../../../cli/services/cue-standalone-engine';
import type { CueEngine } from '../../../main/cue/cue-engine';
import type { CueEvent } from '../../../main/cue/cue-types';
import type { CueBundleImportHost } from '../../../main/cue/bundle/cue-bundle-importer';
import { resolveClaudeMemoryPath } from '../../../shared/maestro-lib/translation/memory';
import { readZipArchive } from '../../../main/utils/zip-archive';
import { readSessionsStoreFile } from '../../../main/stores/sessions-store-file';
import { buildAgentLaunchPlan } from '../../../shared/maestro-lib/launch/launch-plan';
import { getAgentDefinition } from '../../../shared/maestro-lib/providers/definitions';
import { getAgentCapabilities } from '../../../shared/maestro-lib/providers/capabilities';
import { writeCueBundle } from '../../helpers/cueBundleFixture';
import type { CueBundleManifest } from '../../../shared/cue-bundle-types';
import type { SessionInfo } from '../../../shared/types';
vi.mock('../../../main/cue/cue-db', () => buildCueDbModuleMock(() => getSharedDb()));
vi.mock('../../../shared/maestro-lib/parsers', () => ({ initializeOutputParsers: vi.fn() }));
vi.mock('../../../main/cue/cue-executor', () => ({
	executeCuePrompt,
	stopCueRun: vi.fn(),
	getActiveProcesses: () => new Map(),
}));
vi.mock('../../../main/cue/cue-shell-executor', () => ({
	executeCueShell: vi.fn(),
	stopCueShellRun: vi.fn(),
}));
vi.mock('../../../main/cue/cue-cli-executor', () => ({
	executeCueCli: vi.fn(),
	stopCueCliRun: vi.fn(),
}));
vi.mock('../../../main/cue/cue-notify-executor', () => ({ executeCueNotify: vi.fn() }));
let sharedDb: InMemoryCueDb | null = null;
function getSharedDb(): InMemoryCueDb {
	if (!sharedDb) sharedDb = createInMemoryCueDb();
	return sharedDb;
}

const executeCuePrompt = vi.hoisted(() => vi.fn());

describeSourceSuite('cue-standalone-import-restart', () => {
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
		// The engine's chokidar watchers close asynchronously, and Windows refuses to
		// delete a folder whose handle is still open (EBUSY / EPERM), so retry.
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	});

	describe('standalone engine and bundle import: restart picks up the change', () => {
		it('arms an agent and its subscription imported while the engine was stopped', async () => {
			await importAgent(ALPHA, path.join(root, 'server-work', 'alpha'));
			const first = await startEngine();
			expect(armed(first)).toEqual({ [ALPHA]: ['alpha-nightly'] });

			// Import refuses while this engine holds the data directory.
			await expect(importAgent(BETA, path.join(root, 'server-work', 'beta'))).rejects.toMatchObject(
				{
					code: 'ENGINE_RUNNING',
				} satisfies Partial<CueBundleImportError>
			);

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
});
describeSourceSuite('cue-bundle-claude-roundtrip', () => {
	const AGENT_ID = '3f9b2c1e-6a4d-4e8f-9b0a-1c2d3e4f5a6b';
	const CODEX_ID = '8a7b6c5d-4e3f-4a1b-9c8d-7e6f5a4b3c2d';
	const GITHUB_PAT = 'ghp_' + 'Q'.repeat(36);

	let tmp: string;
	let src: { dataDir: string; root: string; claudeDir: string };

	function write(file: string, content: string): void {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}

	function entriesOf(zipPath: string): Map<string, string> {
		return new Map(
			readZipArchive(zipPath)
				.getEntries()
				.map((e) => [e.entryName, e.getData().toString('utf-8')])
		);
	}

	beforeEach(() => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cue-claude-roundtrip-')));
		const root = path.join(tmp, 'src-work', 'app');
		const dataDir = path.join(tmp, 'src-data');
		const claudeDir = path.join(tmp, 'src-claude');
		src = { dataDir, root, claudeDir };

		write(
			path.join(dataDir, 'maestro-sessions.json'),
			JSON.stringify({
				sessions: [
					{ id: AGENT_ID, name: 'Reviewer', toolType: 'claude-code', cwd: root, projectRoot: root },
				],
			})
		);
		write(
			path.join(root, '.maestro/cue.yaml'),
			'subscriptions:\n  - name: nightly\n    event: time.heartbeat\n    interval_minutes: 60\n    prompt: review\n'
		);
		write(
			path.join(root, '.claude/skills/triage/SKILL.md'),
			'---\nname: triage\n---\nTriage it.\n'
		);
		write(
			path.join(root, '.mcp.json'),
			JSON.stringify({
				mcpServers: { github: { command: 'gh-mcp', env: { GITHUB_TOKEN: GITHUB_PAT } } },
			})
		);
		write(path.join(root, 'CLAUDE.md'), '# App\nBuild with npm.\n');
		write(
			path.join(resolveClaudeMemoryPath(root, claudeDir), 'MEMORY.md'),
			'- deploys go out on Fridays\n'
		);
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	async function exportAgent(opts: Partial<Parameters<typeof exportCueBundle>[0]> = {}) {
		const outputPath = path.join(tmp, 'agent.zip');
		const result = await exportCueBundle({
			dataDir: src.dataDir,
			agentId: AGENT_ID,
			outputPath,
			producerVersion: '0.18.0',
			claudeConfigDir: src.claudeDir,
			...opts,
		});
		return { outputPath, manifest: result.manifest };
	}

	function target(name = 'dst') {
		const root = path.join(tmp, `${name}-work`, 'app');
		fs.mkdirSync(root, { recursive: true });
		return {
			root,
			dataDir: path.join(tmp, `${name}-data`),
			claudeDir: path.join(tmp, `${name}-claude`),
		};
	}

	describe('Claude Code assets in an agent bundle', () => {
		it('exports skills, the scrubbed MCP config and memory, and lists the MCP secret', async () => {
			const { outputPath, manifest } = await exportAgent();
			const entries = entriesOf(outputPath);
			expect([...entries.keys()]).toEqual(
				expect.arrayContaining([
					'workspaces/app/.claude/skills/triage/SKILL.md',
					'workspaces/app/.mcp.json',
					'workspaces/app/CLAUDE.md',
					'claude-memory/app/MEMORY.md',
				])
			);
			expect(entries.get('workspaces/app/.mcp.json')).not.toContain(GITHUB_PAT);
			expect(JSON.parse(entries.get('workspaces/app/.mcp.json')!).mcpServers.github.env).toEqual({
				GITHUB_TOKEN: '${GITHUB_TOKEN}',
			});
			expect(manifest.requirements.secrets).toContain('GITHUB_TOKEN');
			expect(manifest.workspaces[0].claude).toEqual({
				skills: ['triage'],
				mcpServers: ['github'],
				projectMemory: ['CLAUDE.md'],
				autoMemory: ['MEMORY.md'],
			});
		});

		it("reads memory from the account the agent runs as, not Maestro's default", async () => {
			const workAccount = path.join(tmp, 'claude-work');
			write(
				path.join(resolveClaudeMemoryPath(src.root, workAccount), 'MEMORY.md'),
				'- work account notes\n'
			);
			const sessions = JSON.parse(
				fs.readFileSync(path.join(src.dataDir, 'maestro-sessions.json'), 'utf-8')
			);
			sessions.sessions[0].customEnvVars = { CLAUDE_CONFIG_DIR: workAccount };
			write(path.join(src.dataDir, 'maestro-sessions.json'), JSON.stringify(sessions));

			const { outputPath } = await exportAgent();
			expect(entriesOf(outputPath).get('claude-memory/app/MEMORY.md')).toBe(
				'- work account notes\n'
			);
		});

		it('says which account it used when Claude agents in one workspace differ', async () => {
			const sessions = JSON.parse(
				fs.readFileSync(path.join(src.dataDir, 'maestro-sessions.json'), 'utf-8')
			);
			sessions.sessions.push({
				id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
				name: 'Second',
				toolType: 'claude-code',
				cwd: src.root,
				projectRoot: src.root,
				customEnvVars: { CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-other') },
			});
			write(path.join(src.dataDir, 'maestro-sessions.json'), JSON.stringify(sessions));
			write(
				path.join(src.root, '.maestro/cue.yaml'),
				`subscriptions:\n  - name: a\n    event: time.heartbeat\n    interval_minutes: 60\n    prompt: x\n    agent_id: ${AGENT_ID}\n    pipeline_name: P\n  - name: b\n    event: time.heartbeat\n    interval_minutes: 60\n    prompt: y\n    agent_id: ffffffff-ffff-4fff-8fff-ffffffffffff\n    pipeline_name: P\n`
			);
			const { manifest } = await exportAgent({ agentId: undefined, pipeline: 'P' });
			expect(manifest.agents).toHaveLength(2);
			expect(manifest.warnings).toEqual(
				expect.arrayContaining([expect.stringContaining('use different Claude accounts')])
			);
		});

		it('leaves the assets out when switched off', async () => {
			const { outputPath, manifest } = await exportAgent({
				claudeAssets: { skills: false, mcp: false, memory: false },
			});
			const names = [...entriesOf(outputPath).keys()];
			expect(names.some((n) => n.includes('.claude/') || n.includes('.mcp.json'))).toBe(false);
			expect(names.some((n) => n.startsWith('claude-memory/'))).toBe(false);
			expect(manifest.workspaces[0].claude).toBeUndefined();
		});

		it('carries no Claude assets for an agent of another provider', async () => {
			const sessions = JSON.parse(
				fs.readFileSync(path.join(src.dataDir, 'maestro-sessions.json'), 'utf-8')
			);
			sessions.sessions[0] = { ...sessions.sessions[0], id: CODEX_ID, toolType: 'codex' };
			write(path.join(src.dataDir, 'maestro-sessions.json'), JSON.stringify(sessions));
			const { manifest } = await exportAgent({ agentId: CODEX_ID });
			expect(manifest.workspaces[0].claude).toBeUndefined();
		});

		it('imports memory under the target path and merges into an existing .mcp.json', async () => {
			const { outputPath } = await exportAgent();
			const dst = target();
			write(
				path.join(dst.root, '.mcp.json'),
				JSON.stringify({ mcpServers: { local: { command: 'local-mcp' } } })
			);

			const { plan } = await importCueBundle({
				bundlePath: outputPath,
				dataDir: dst.dataDir,
				workspaces: { app: dst.root },
				runningVersion: '99.0.0',
				claudeConfigDir: dst.claudeDir,
				env: {},
			});

			expect(
				fs.readFileSync(path.join(dst.root, '.claude/skills/triage/SKILL.md'), 'utf-8')
			).toContain('Triage it.');
			expect(
				JSON.parse(fs.readFileSync(path.join(dst.root, '.mcp.json'), 'utf-8')).mcpServers
			).toEqual({
				local: { command: 'local-mcp' },
				github: { command: 'gh-mcp', env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
			});
			const memory = path.join(resolveClaudeMemoryPath(dst.root, dst.claudeDir), 'MEMORY.md');
			expect(fs.readFileSync(memory, 'utf-8')).toBe('- deploys go out on Fridays\n');
			expect(plan.files.find((f) => f.kind === 'claude-memory')?.target).toBe(memory);
			expect(plan.secrets.find((s) => s.name === 'GITHUB_TOKEN')).toMatchObject({
				set: false,
				// The Claude agent declares it too, so its launch receives it.
				usedBy: ['agent:Reviewer', 'mcp:app'],
			});
		});

		it.skipIf(process.platform === 'win32')(
			'keeps a skill script executable through export and import',
			async () => {
				const script = path.join(src.root, '.claude/skills/triage/scripts/check.sh');
				write(script, '#!/bin/sh\necho ok\n');
				fs.chmodSync(script, 0o755);
				const { outputPath, manifest } = await exportAgent();
				expect(
					manifest.files.find(
						(f) => f.path === 'workspaces/app/.claude/skills/triage/scripts/check.sh'
					)
				).toMatchObject({ executable: true });
				expect(
					manifest.files.find((f) => f.path === 'workspaces/app/.claude/skills/triage/SKILL.md')
						?.executable
				).toBeUndefined();

				const dst = target();
				await importCueBundle({
					bundlePath: outputPath,
					dataDir: dst.dataDir,
					workspaces: { app: dst.root },
					runningVersion: '99.0.0',
					claudeConfigDir: dst.claudeDir,
				});
				const imported = path.join(dst.root, '.claude/skills/triage/scripts/check.sh');
				expect(fs.statSync(imported).mode & 0o111).not.toBe(0);
				expect(
					fs.statSync(path.join(dst.root, '.claude/skills/triage/SKILL.md')).mode & 0o111
				).toBe(0);
			}
		);

		it.skipIf(process.platform === 'win32')(
			'restores a lost executable bit on re-import, except on Windows where no file has one',
			async () => {
				const script = path.join(src.root, '.claude/skills/triage/scripts/check.sh');
				write(script, '#!/bin/sh\necho ok\n');
				fs.chmodSync(script, 0o755);
				const { outputPath } = await exportAgent();
				const dst = target();
				const importAgain = (force = true) =>
					importCueBundle({
						bundlePath: outputPath,
						dataDir: dst.dataDir,
						workspaces: { app: dst.root },
						runningVersion: '99.0.0',
						claudeConfigDir: dst.claudeDir,
						force,
					});
				await importAgain(false);
				const imported = path.join(dst.root, '.claude/skills/triage/scripts/check.sh');

				fs.chmodSync(imported, 0o644);
				await importAgain();
				expect(fs.statSync(imported).mode & 0o111).not.toBe(0);

				// Windows stats every file without executable bits, so the same bytes are not rewritten there.
				fs.chmodSync(imported, 0o644);
				const originalPlatform = process.platform;
				Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
				try {
					await importAgain();
				} finally {
					Object.defineProperty(process, 'platform', {
						value: originalPlatform,
						configurable: true,
					});
				}
				expect(fs.statSync(imported).mode & 0o111).toBe(0);
			}
		);

		it('reports an MCP server that differs as a conflict', async () => {
			const { outputPath } = await exportAgent();
			const dst = target();
			write(
				path.join(dst.root, '.mcp.json'),
				JSON.stringify({ mcpServers: { github: { command: 'other' } } })
			);
			const plan = importCueBundle({
				bundlePath: outputPath,
				dataDir: dst.dataDir,
				workspaces: { app: dst.root },
				runningVersion: '99.0.0',
				claudeConfigDir: dst.claudeDir,
			});
			await expect(plan).rejects.toMatchObject({ code: 'CONFLICTS' });
			await plan.catch((error: CueBundleImportError) => {
				expect(error.details.conflicts).toEqual([
					expect.objectContaining({ kind: 'file', message: expect.stringContaining('"github"') }),
				]);
			});
		});
	});

	describe('import into a running app (host)', () => {
		function host(sessions: SessionInfo[] = []) {
			const applied: Array<{ created: SessionInfo[]; updated: SessionInfo[] }> = [];
			const h: CueBundleImportHost = {
				sessions,
				applyAgents: vi.fn(async (change) => {
					applied.push(change);
				}),
			};
			return { host: h, applied };
		}

		/** A data dir the desktop is "running" against: a live discovery file. */
		function liveDataDir(): string {
			const dataDir = path.join(tmp, 'app-data');
			write(
				path.join(dataDir, 'cli-server.json'),
				JSON.stringify({ port: 1, token: 't', pid: process.pid, startedAt: Date.now() })
			);
			return dataDir;
		}

		it('hands the agents to the app and writes no sessions file, past the running-app check', async () => {
			const { outputPath } = await exportAgent();
			const dst = target();
			const dataDir = liveDataDir();
			const { host: h, applied } = host();

			const { plan } = await importCueBundle({
				bundlePath: outputPath,
				dataDir,
				workspaces: { app: dst.root },
				runningVersion: '99.0.0',
				claudeConfigDir: dst.claudeDir,
				host: h,
			});

			expect(plan.agents).toEqual([expect.objectContaining({ id: AGENT_ID, action: 'create' })]);
			expect(applied).toHaveLength(1);
			expect(applied[0].created.map((s) => [s.id, s.name, s.projectRoot])).toEqual([
				[AGENT_ID, 'Reviewer', dst.root],
			]);
			expect(applied[0].updated).toEqual([]);
			expect(fs.existsSync(path.join(dataDir, 'maestro-sessions.json'))).toBe(false);
			expect(fs.existsSync(path.join(dst.root, '.maestro/cue.yaml'))).toBe(true);
		});

		it('checks names against the app, not the disk', async () => {
			const { outputPath } = await exportAgent();
			const dst = target();
			const { host: h } = host([
				{ id: 'someone-else', name: 'reviewer', toolType: 'codex', cwd: dst.root } as SessionInfo,
			]);
			await expect(
				importCueBundle({
					bundlePath: outputPath,
					dataDir: liveDataDir(),
					workspaces: { app: dst.root },
					runningVersion: '99.0.0',
					claudeConfigDir: dst.claudeDir,
					host: h,
				})
			).rejects.toMatchObject({ code: 'AGENT_NAME_TAKEN' });
		});

		it('refuses binary paths, which the app keeps in memory', async () => {
			const { outputPath } = await exportAgent();
			const dst = target();
			await expect(
				importCueBundle({
					bundlePath: outputPath,
					dataDir: liveDataDir(),
					workspaces: { app: dst.root },
					runningVersion: '99.0.0',
					agentPaths: { 'claude-code': '/usr/local/bin/claude' },
					host: host().host,
				})
			).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
		});

		it('rolls the files back when the app refuses the agents', async () => {
			const { outputPath } = await exportAgent();
			const dst = target();
			const h: CueBundleImportHost = {
				sessions: [],
				applyAgents: async () => {
					throw new Error('renderer did not answer');
				},
			};
			await expect(
				importCueBundle({
					bundlePath: outputPath,
					dataDir: liveDataDir(),
					workspaces: { app: dst.root },
					runningVersion: '99.0.0',
					claudeConfigDir: dst.claudeDir,
					host: h,
				})
			).rejects.toMatchObject({ code: 'WRITE_FAILED' });
			expect(fs.existsSync(path.join(dst.root, '.maestro/cue.yaml'))).toBe(false);
			expect(fs.existsSync(path.join(dst.root, '.mcp.json'))).toBe(false);
		});

		it('still refuses a plain import while the app runs', async () => {
			const { outputPath } = await exportAgent();
			const dst = target();
			await expect(
				importCueBundle({
					bundlePath: outputPath,
					dataDir: liveDataDir(),
					workspaces: { app: dst.root },
					runningVersion: '99.0.0',
				})
			).rejects.toMatchObject({ code: 'DESKTOP_RUNNING' });
		});
	});

	describe('manifest', () => {
		it('round-trips the claude record through JSON', async () => {
			const { outputPath } = await exportAgent();
			const manifest = JSON.parse(entriesOf(outputPath).get('manifest.json')!) as CueBundleManifest;
			expect(manifest.workspaces[0].claude?.autoMemory).toEqual(['MEMORY.md']);
		});
	});

	describe('MCP secrets reach the Claude agents that load the config', () => {
		const SECRET = 'REVIEW_GH_TOKEN';
		const VALUE = 'mcp-secret-value-5c1d-do-not-leak';

		/** Reviewer (Claude) and a Codex agent in the same workspace, in pipeline P. */
		function seedPipeline(mcpEnvKey = SECRET): void {
			write(
				path.join(src.dataDir, 'maestro-sessions.json'),
				JSON.stringify({
					sessions: [
						{
							id: AGENT_ID,
							name: 'Reviewer',
							toolType: 'claude-code',
							cwd: src.root,
							projectRoot: src.root,
						},
						{
							id: CODEX_ID,
							name: 'Coder',
							toolType: 'codex',
							cwd: src.root,
							projectRoot: src.root,
						},
					],
				})
			);
			write(
				path.join(src.root, '.maestro/cue.yaml'),
				`subscriptions:\n  - name: a\n    event: time.heartbeat\n    interval_minutes: 60\n    prompt: x\n    agent_id: ${AGENT_ID}\n    pipeline_name: P\n  - name: b\n    event: time.heartbeat\n    interval_minutes: 60\n    prompt: y\n    agent_id: ${CODEX_ID}\n    pipeline_name: P\n`
			);
			write(
				path.join(src.root, '.mcp.json'),
				JSON.stringify({
					mcpServers: {
						github: { command: 'gh-mcp', env: { [mcpEnvKey]: GITHUB_PAT } },
						// Configuration, not a secret: no agent is asked for HOME.
						docs: { command: 'docs-mcp', args: ['--root', '${HOME}/docs'] },
					},
				})
			);
		}

		async function exportPipeline(name: string) {
			const outputPath = path.join(tmp, name);
			const result = await exportCueBundle({
				dataDir: src.dataDir,
				pipeline: 'P',
				outputPath,
				producerVersion: '0.18.0',
				claudeConfigDir: src.claudeDir,
			});
			return { outputPath, manifest: result.manifest };
		}

		function importedAgents(dataDir: string) {
			const sessions = readSessionsStoreFile(dataDir).sessions;
			return {
				claude: sessions.find((s) => s.id === AGENT_ID)!,
				codex: sessions.find((s) => s.id === CODEX_ID)!,
			};
		}

		function launchEnv(toolType: 'claude-code' | 'codex', requiredSecrets: string[] | undefined) {
			const runSecretsDir = path.join(tmp, 'run-secrets');
			write(path.join(runSecretsDir, SECRET), `${VALUE}\n`);
			const result = buildAgentLaunchPlan({
				surface: 'cue',
				agent: { ...getAgentDefinition(toolType), capabilities: getAgentCapabilities(toolType) },
				command: `/usr/local/bin/${toolType}`,
				args: [],
				cwd: '/project',
				prompt: 'go',
				isWindowsHost: false,
				isServerMode: true,
				requiredSecrets,
				secretLookup: { env: {}, runSecretsDir },
			});
			if (!result.ok) throw new Error(result.error);
			return result.plan.env ?? {};
		}

		it("export lists them in the Claude agent's env.required and not the other agent's", async () => {
			seedPipeline();
			const { outputPath, manifest } = await exportPipeline('p.zip');
			const entries = entriesOf(outputPath);
			const settingsOf = (id: string) => JSON.parse(entries.get(`agents/${id}.json`)!);
			expect(manifest.requirements.secrets).toContain(SECRET);
			expect(manifest.requirements.secrets).not.toContain('HOME');
			expect(settingsOf(AGENT_ID).env?.required).toEqual([SECRET]);
			expect(settingsOf(CODEX_ID).env?.required).toBeUndefined();
		});

		it('import sets requiredSecrets on the Claude agent only, and its launch alone receives the file', async () => {
			seedPipeline();
			const { outputPath } = await exportPipeline('p.zip');
			const dst = target();
			await importCueBundle({
				bundlePath: outputPath,
				dataDir: dst.dataDir,
				workspaces: { app: dst.root },
				runningVersion: '99.0.0',
				claudeConfigDir: dst.claudeDir,
				env: {},
				runSecretsDir: null,
			});
			const { claude, codex } = importedAgents(dst.dataDir);
			expect(claude.requiredSecrets).toEqual([SECRET]);
			expect(codex.requiredSecrets).toBeUndefined();

			const claudeEnv = launchEnv('claude-code', claude.requiredSecrets);
			expect(claudeEnv[SECRET]).toBe(VALUE);
			const codexEnv = launchEnv('codex', codex.requiredSecrets);
			expect(codexEnv[SECRET]).toBeUndefined();
			expect(Object.values(codexEnv)).not.toContain(VALUE);
			// Delivered as the one variable, nowhere else in the Claude launch.
			expect(Object.entries(claudeEnv).filter(([, v]) => v === VALUE)).toEqual([[SECRET, VALUE]]);
		});

		it('a forced re-import replaces the names with what the new config references', async () => {
			seedPipeline();
			const dst = target();
			const importIt = async (zip: string, force = false) =>
				importCueBundle({
					bundlePath: zip,
					dataDir: dst.dataDir,
					workspaces: { app: dst.root },
					runningVersion: '99.0.0',
					claudeConfigDir: dst.claudeDir,
					env: {},
					runSecretsDir: null,
					force,
				});
			await importIt((await exportPipeline('first.zip')).outputPath);
			expect(importedAgents(dst.dataDir).claude.requiredSecrets).toEqual([SECRET]);

			seedPipeline(`${SECRET}_V2`);
			await importIt((await exportPipeline('second.zip')).outputPath, true);
			const { claude, codex } = importedAgents(dst.dataDir);
			expect(claude.requiredSecrets).toEqual([`${SECRET}_V2`]);
			expect(codex.requiredSecrets).toBeUndefined();
		});

		it("reads them from the bundled .mcp.json when an older export left them out of the agent's settings", async () => {
			const file = writeCueBundle(path.join(tmp, 'older.zip'), {
				files: (files) => {
					files.set(
						'workspaces/proj/.mcp.json',
						JSON.stringify({
							mcpServers: {
								api: {
									url: 'https://mcp.example.com',
									headers: { Authorization: 'Bearer ${MCP_API_AUTHORIZATION}' },
								},
								docs: { command: 'docs-mcp', args: ['${HOME}/docs'] },
							},
						})
					);
					files.set(
						'agents/agent-b.json',
						JSON.stringify({ id: 'agent-b', name: 'Beta', toolType: 'codex', workspace: 'proj' })
					);
				},
				manifest: (manifest) => {
					manifest.requirements.secrets.push('MCP_API_AUTHORIZATION');
					manifest.agents.push({
						id: 'agent-b',
						name: 'Beta',
						toolType: 'codex',
						workspace: 'proj',
						settings: 'agents/agent-b.json',
					});
				},
			});
			const dst = target();
			await importCueBundle({
				bundlePath: file,
				dataDir: dst.dataDir,
				workspaces: { proj: dst.root },
				runningVersion: '99.0.0',
				claudeConfigDir: dst.claudeDir,
				env: {},
				runSecretsDir: null,
			});
			const sessions = readSessionsStoreFile(dst.dataDir).sessions;
			expect(sessions.find((s) => s.id === 'agent-a')!.requiredSecrets).toEqual([
				'API_KEY',
				'MCP_API_AUTHORIZATION',
			]);
			expect(sessions.find((s) => s.id === 'agent-b')!.requiredSecrets).toBeUndefined();
		});
	});
});
