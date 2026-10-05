/**
 * Bundle importer, run against real files in a temp directory: a round trip
 * through the exporter into a fresh data dir, then a synthetic bundle broken
 * or blocked one way per test. Every refusal must leave the target untouched,
 * so those tests compare a full snapshot of the target before and after.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

vi.mock('../../../../main/stores/sessions-store-file', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../../main/stores/sessions-store-file')>();
	return { ...actual, writeSessionsStoreFile: vi.fn(actual.writeSessionsStoreFile) };
});

import { exportCueBundle } from '../../../../main/cue/bundle/cue-bundle-exporter';
import {
	CueBundleImportError,
	importCueBundle,
	planCueBundleImport,
	type CueBundleImportOptions,
} from '../../../../main/cue/bundle/cue-bundle-importer';
import {
	readSessionsStoreFile,
	writeSessionsStoreFile,
} from '../../../../main/stores/sessions-store-file';
import { acquireCueEngineLock, releaseCueEngineLock } from '../../../../main/cue/cue-engine-lock';
import { loadCueConfigDetailed } from '../../../../main/cue/cue-yaml-loader';
import { loadPipelineLayout } from '../../../../main/cue/pipeline-layout-store';
import { readSessions } from '../../../../cli/services/storage';
import { FIXTURE_CUE_PATH, writeCueBundle } from '../../../helpers/cueBundleFixture';

const RUNNING = '0.18.6-RC';

let tmp: string;
const originalUserData = process.env.MAESTRO_USER_DATA;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cue-bundle-import-')));
});

afterEach(() => {
	if (originalUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = originalUserData;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function writeJson(file: string, value: unknown): void {
	write(file, JSON.stringify(value, null, '\t'));
}

/** Every file under `dir` with its content, plus every directory, for before/after comparison. */
function snapshot(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!fs.existsSync(dir)) return out;
	const walk = (d: string) => {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			const full = path.join(d, entry.name);
			const rel = path.relative(dir, full);
			if (entry.isDirectory()) {
				out[`${rel}/`] = '';
				walk(full);
			} else if (entry.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(full)}`;
			else out[rel] = fs.readFileSync(full, 'utf-8');
		}
	};
	walk(dir);
	return out;
}

async function importError(options: CueBundleImportOptions): Promise<CueBundleImportError> {
	try {
		await importCueBundle(options);
	} catch (error) {
		expect(error).toBeInstanceOf(CueBundleImportError);
		return error as CueBundleImportError;
	}
	throw new Error('expected the import to fail');
}

// ─── Round trip through the exporter ────────────────────────────────────────

describe('importCueBundle round trip', () => {
	let bundle: string;
	let dataDir: string;
	let appRoot: string;

	beforeEach(async () => {
		const srcData = path.join(tmp, 'src-data');
		const srcRoot = path.join(tmp, 'src', 'app');
		const outsideDocs = path.join(tmp, 'src', 'outside-docs');
		write(path.join(srcRoot, '.maestro/prompts/review.md'), 'Review the code.\n');
		write(path.join(srcRoot, '.maestro/playbooks/nightly.md'), '- [ ] nightly task\n');
		write(path.join(outsideDocs, 'runbook.md'), '- [ ] run the book\n');
		fs.mkdirSync(path.join(srcRoot, 'ops'), { recursive: true });
		write(
			path.join(srcRoot, '.maestro/cue.yaml'),
			yaml.dump({
				settings: { owner_agent_id: 'agent-lead' },
				subscriptions: [
					{
						name: 'review',
						event: 'time.heartbeat',
						agent_id: 'agent-lead',
						interval_minutes: 10,
						prompt_file: '.maestro/prompts/review.md',
						pipeline_name: 'Review',
					},
					{
						name: 'deploy',
						event: 'agent.completed',
						agent_id: 'agent-ops',
						source_session: 'Lead',
						source_sub: 'review',
						action: 'command',
						command: { mode: 'shell', shell: 'make deploy' },
						prompt: 'deploy',
						pipeline_name: 'Review',
					},
				],
			})
		);
		writeJson(path.join(srcData, 'maestro-sessions.json'), {
			sessions: [
				{
					id: 'agent-lead',
					name: 'Lead',
					toolType: 'claude-code',
					cwd: srcRoot,
					projectRoot: srcRoot,
					autoRunFolderPath: path.join(srcRoot, '.maestro/playbooks'),
					customModel: 'opus',
					customEnvVars: { LOG_LEVEL: 'debug', ANTHROPIC_API_KEY: 'sk-ant-secret-value' },
				},
				{
					id: 'agent-ops',
					name: 'Ops',
					toolType: 'codex',
					cwd: path.join(srcRoot, 'ops'),
					projectRoot: srcRoot,
					autoRunFolderPath: outsideDocs,
				},
			],
		});
		const playbook = (id: string, filename: string) => ({
			playbooks: [
				{
					id,
					name: id,
					createdAt: 1,
					updatedAt: 2,
					documents: [{ filename, resetOnCompletion: false }],
					loopEnabled: false,
					prompt: 'Do the tasks',
				},
			],
		});
		writeJson(path.join(srcData, 'playbooks', 'agent-lead.json'), playbook('pb-lead', 'nightly'));
		writeJson(path.join(srcData, 'playbooks', 'agent-ops.json'), playbook('pb-ops', 'runbook'));
		writeJson(path.join(srcData, 'cue-pipeline-layout.json'), {
			version: 2,
			pipelines: [{ id: 'p-review', name: 'Review', color: '#ff0000', nodes: [], edges: [] }],
			selectedPipelineId: null,
			perProject: {},
		});

		bundle = path.join(tmp, 'review.zip');
		await exportCueBundle({
			dataDir: srcData,
			pipeline: 'Review',
			outputPath: bundle,
			producerVersion: '0.18.0',
		});

		dataDir = path.join(tmp, 'server', 'data');
		appRoot = path.join(tmp, 'server', 'app');
		fs.mkdirSync(path.join(appRoot, 'ops'), { recursive: true });
	});

	const options = (extra: Partial<CueBundleImportOptions> = {}): CueBundleImportOptions => ({
		bundlePath: bundle,
		dataDir,
		workspaces: { app: appRoot },
		runningVersion: RUNNING,
		env: {},
		...extra,
	});

	it('creates the data dir and writes agents the desktop, CLI and engine can all read', async () => {
		const logs: string[] = [];
		const result = await importCueBundle(options({ onLog: (_level, m) => logs.push(m) }));

		expect(result.applied).toBe(true);
		expect(result.plan.createDataDir).toBe(true);
		expect(logs).toContain(`Created the data directory ${dataDir}.`);

		// Desktop: the restored record has exactly one tab, so it is not "corrupt".
		const { sessions } = readSessionsStoreFile(dataDir);
		const byId = new Map(sessions.map((s) => [s.id, s as Record<string, any>]));
		expect([...byId.keys()].sort()).toEqual(['agent-lead', 'agent-ops']);
		for (const s of byId.values()) {
			expect(s.aiTabs).toHaveLength(1);
			expect(s.activeTabId).toBe(s.aiTabs[0].id);
			expect(s.unifiedTabOrder).toEqual([{ type: 'ai', id: s.aiTabs[0].id }]);
		}
		const lead = byId.get('agent-lead')!;
		expect(lead).toMatchObject({
			name: 'Lead',
			toolType: 'claude-code',
			cwd: appRoot,
			projectRoot: appRoot,
			autoRunFolderPath: path.join(appRoot, '.maestro/playbooks'),
			customModel: 'opus',
			customEnvVars: { LOG_LEVEL: 'debug' },
			claudeInteractive: { mode: 'api', modeReason: 'auto' },
		});
		expect(lead.aiTabs[0]).toMatchObject({ saveToHistory: true, showThinking: 'off' });
		const ops = byId.get('agent-ops')!;
		expect(ops).toMatchObject({
			cwd: path.join(appRoot, 'ops'),
			projectRoot: appRoot,
			autoRunFolderPath: path.join(dataDir, 'autorun', 'agent-ops'),
		});

		// CLI: resolves agents from the same data dir.
		process.env.MAESTRO_USER_DATA = dataDir;
		expect(
			readSessions()
				.map((s) => s.id)
				.sort()
		).toEqual(['agent-lead', 'agent-ops']);

		// Engine: the workspace config loads, with its prompt file materialized.
		const loaded = loadCueConfigDetailed(appRoot);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		const review = loaded.config.subscriptions.find((s) => s.name === 'review');
		expect(review?.prompt).toContain('Review the code.');
		expect(loaded.config.subscriptions.map((s) => s.name).sort()).toEqual(['deploy', 'review']);

		// Files, playbooks and the layout landed where the records point.
		expect(fs.readFileSync(path.join(appRoot, '.maestro/playbooks/nightly.md'), 'utf-8')).toBe(
			'- [ ] nightly task\n'
		);
		expect(fs.readFileSync(path.join(dataDir, 'autorun/agent-ops/runbook.md'), 'utf-8')).toBe(
			'- [ ] run the book\n'
		);
		expect(
			JSON.parse(fs.readFileSync(path.join(dataDir, 'playbooks/agent-lead.json'), 'utf-8'))
				.playbooks[0].id
		).toBe('pb-lead');
		expect(loadPipelineLayout(dataDir)?.pipelines.map((p) => p.name)).toEqual(['Review']);
	});

	it('reports shell steps and secrets in the plan', async () => {
		const plan = await planCueBundleImport(options());
		expect(plan.shellCommands).toEqual([
			{ workspace: 'app', subscription: 'deploy', command: 'make deploy' },
		]);
		const secret = plan.secrets.find((s) => s.name === 'ANTHROPIC_API_KEY');
		expect(secret).toMatchObject({
			set: false,
			usedBy: ['agent:Lead'],
			passesServerAllowlist: true,
		});
		expect(fs.existsSync(dataDir)).toBe(false);
	});

	it('treats a re-import as conflicts on the agents only, and force keeps their tabs', async () => {
		await importCueBundle(options());
		const { data } = readSessionsStoreFile(dataDir);
		const sessions = data!.sessions as Array<Record<string, any>>;
		sessions[0].aiTabs = [{ ...sessions[0].aiTabs[0], id: 'kept-tab', name: 'Mine' }];
		sessions[0].activeTabId = 'kept-tab';
		await writeSessionsStoreFile(dataDir, data!);
		const cueBefore = fs.readFileSync(path.join(appRoot, '.maestro/cue.yaml'), 'utf-8');

		const plan = await planCueBundleImport(options());
		expect(plan.conflicts.map((c) => `${c.kind}:${c.target}`).sort()).toEqual([
			'agent:agent-lead',
			'agent:agent-ops',
		]);
		expect(plan.files.every((f) => f.action === 'unchanged')).toBe(true);
		expect(plan.cueConfigs[0]).toMatchObject({
			added: [],
			replaced: [],
			unchanged: ['review', 'deploy'],
		});
		expect(plan.pipeline?.action).toBe('unchanged');

		const blocked = await importError(options());
		expect(blocked.code).toBe('CONFLICTS');

		await importCueBundle(options({ force: true }));
		const lead = readSessionsStoreFile(dataDir).sessions.find(
			(s) => s.id === sessions[0].id
		) as Record<string, any>;
		expect(lead.aiTabs.map((t: { id: string }) => t.id)).toEqual(['kept-tab']);
		expect(fs.readFileSync(path.join(appRoot, '.maestro/cue.yaml'), 'utf-8')).toBe(cueBefore);
	});
});

// ─── Synthetic bundle: gates, conflicts, merge, rollback ────────────────────

describe('importCueBundle against a fixture bundle', () => {
	let dataDir: string;
	let projRoot: string;

	beforeEach(() => {
		dataDir = path.join(tmp, 'data');
		projRoot = path.join(tmp, 'proj');
		fs.mkdirSync(dataDir, { recursive: true });
		fs.mkdirSync(projRoot, { recursive: true });
	});

	const options = (
		fixture: Parameters<typeof writeCueBundle>[1] = {},
		extra: Partial<CueBundleImportOptions> = {}
	): CueBundleImportOptions => ({
		bundlePath: writeCueBundle(path.join(tmp, 'bundle.zip'), fixture),
		dataDir,
		workspaces: { proj: projRoot },
		runningVersion: RUNNING,
		env: {},
		...extra,
	});

	/** Run a refused import and prove it changed nothing on disk. */
	async function refused(opts: CueBundleImportOptions): Promise<CueBundleImportError> {
		const before = { data: snapshot(dataDir), proj: snapshot(projRoot) };
		const error = await importError(opts);
		expect({ data: snapshot(dataDir), proj: snapshot(projRoot) }).toEqual(before);
		return error;
	}

	describe('gates', () => {
		it('refuses an unreadable bundle', async () => {
			const error = await refused({ ...options(), bundlePath: path.join(tmp, 'missing.zip') });
			expect(error.code).toBe('BUNDLE_UNREADABLE');
		});

		it('refuses a bundle whose bytes disagree with its manifest', async () => {
			const error = await refused(
				options({ tamper: { 'workspaces/proj/.maestro/prompts/tick.md': 'X' } })
			);
			expect(error.code).toBe('BUNDLE_INVALID');
			expect((error.details.errors as Array<{ code: string }>).map((e) => e.code)).toContain(
				'hash-mismatch'
			);
		});

		it('refuses a bundle that needs a newer engine', async () => {
			const error = await refused(options({}, { runningVersion: '0.17.0' }));
			expect(error.code).toBe('BUNDLE_INVALID');
			expect(error.message).toContain('engine-too-old');
		});

		it('refuses while a Cue engine holds the data dir', async () => {
			expect(acquireCueEngineLock('standalone', dataDir).acquired).toBe(true);
			try {
				expect((await importError(options())).code).toBe('ENGINE_RUNNING');
			} finally {
				releaseCueEngineLock(dataDir);
			}
		});

		it('refuses while a desktop app runs against the data dir', async () => {
			writeJson(path.join(dataDir, 'cli-server.json'), {
				port: 1,
				token: 't',
				pid: process.pid,
				startedAt: Date.now(),
			});
			expect((await refused(options())).code).toBe('DESKTOP_RUNNING');
		});

		it('ignores a discovery file left by a dead process, and says so', async () => {
			const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
			writeJson(path.join(dataDir, 'cli-server.json'), {
				port: 1,
				token: 't',
				pid: deadPid,
				startedAt: Date.now(),
			});
			const warnings: string[] = [];
			const result = await importCueBundle({
				...options(),
				onLog: (level, m) => level === 'warn' && warnings.push(m),
			});
			expect(result.applied).toBe(true);
			expect(warnings.some((w) => w.includes('stale desktop discovery file'))).toBe(true);
		});

		it('refuses a data dir whose agents live in a custom sync folder', async () => {
			writeJson(path.join(dataDir, 'maestro-bootstrap.json'), { customSyncPath: '/sync/maestro' });
			expect((await refused(options())).code).toBe('SYNC_PATH_REDIRECT');
		});

		it('refuses a sessions file it cannot parse rather than replace it', async () => {
			write(path.join(dataDir, 'maestro-sessions.json'), '{ torn');
			expect((await refused(options())).code).toBe('STORE_CORRUPT');
		});

		it('refuses an unmapped workspace', async () => {
			const error = await refused(options({}, { workspaces: {} }));
			expect(error.code).toBe('WORKSPACE_UNMAPPED');
			expect(error.details.workspaces).toEqual(['proj']);
		});

		it('refuses a mapped folder that does not exist and names what to clone', async () => {
			const error = await refused(options({}, { workspaces: { proj: path.join(tmp, 'nope') } }));
			expect(error.code).toBe('WORKSPACE_NOT_FOUND');
			expect(error.message).toContain('https://github.com/acme/proj.git');
		});

		it('refuses a provider this build does not know', async () => {
			const error = await refused(
				options({
					files: (files) => {
						const agent = JSON.parse(files.get('agents/agent-a.json')!);
						files.set('agents/agent-a.json', JSON.stringify({ ...agent, toolType: 'nope' }));
					},
				})
			);
			expect(error.code).toBe('UNKNOWN_AGENT_TYPE');
		});

		it('refuses a name another agent already has, even with force', async () => {
			writeJson(path.join(dataDir, 'maestro-sessions.json'), {
				sessions: [
					{ id: 'someone-else', name: 'alpha', toolType: 'codex', cwd: '/x', projectRoot: '/x' },
				],
			});
			const error = await refused(options({}, { force: true }));
			expect(error.code).toBe('AGENT_NAME_TAKEN');
		});

		it('refuses to write through a symlink that leaves the workspace', async () => {
			const outside = path.join(tmp, 'outside');
			fs.mkdirSync(outside);
			fs.symlinkSync(outside, path.join(projRoot, '.maestro'));
			const error = await refused(options());
			expect(error.code).toBe('PATH_ESCAPE');
			expect(fs.readdirSync(outside)).toEqual([]);
		});
	});

	describe('security controls', () => {
		const withShell = {
			cue: (doc: { subscriptions: Array<Record<string, unknown>> }) => {
				doc.subscriptions.push({
					name: 'cleanup',
					event: 'time.heartbeat',
					agent_id: 'agent-a',
					interval_minutes: 60,
					action: 'command',
					command: { mode: 'shell', shell: 'rm -rf build' },
					prompt: 'cleanup',
				});
			},
		};

		it('lists every shell step, and refuses them all when asked', async () => {
			const plan = await planCueBundleImport(options(withShell));
			expect(plan.shellCommands).toEqual([
				{ workspace: 'proj', subscription: 'cleanup', command: 'rm -rf build' },
			]);
			const error = await refused(options(withShell, { refuseShellCommands: true }));
			expect(error.code).toBe('SHELL_COMMANDS_REFUSED');
		});

		it('drops unsafe environment variables and reports them', async () => {
			const result = await importCueBundle(
				options({
					files: (files) => {
						const agent = JSON.parse(files.get('agents/agent-a.json')!);
						agent.env.values = { REGION: 'eu', PATH: '/evil', LD_PRELOAD: 'x.so', 'bad-name': 'z' };
						files.set('agents/agent-a.json', JSON.stringify(agent));
					},
				})
			);
			expect(result.plan.env[0]).toMatchObject({
				kept: ['REGION'],
				dropped: ['PATH', 'LD_PRELOAD', 'bad-name'],
			});
			const [agent] = readSessionsStoreFile(dataDir).sessions;
			expect(agent.customEnvVars).toEqual({ REGION: 'eu' });
		});

		it('reports each required secret, who reads it and whether it is set', async () => {
			const plan = await planCueBundleImport(options({}, { env: { API_KEY: 'k' } }));
			expect(plan.secrets.map((s) => ({ name: s.name, set: s.set, usedBy: s.usedBy }))).toEqual([
				{ name: 'API_KEY', set: true, usedBy: ['agent:Alpha'] },
				{ name: 'HOOK_SECRET', set: false, usedBy: ['webhook:hook'] },
			]);
			expect(typeof plan.secrets[0].passesServerAllowlist).toBe('boolean');
			expect(plan.secrets[1].passesServerAllowlist).toBeUndefined();
		});
	});

	describe('conflicts', () => {
		/** The fixture plus saved playbooks for agent-a. */
		const withPlaybooks = {
			files: (files: Map<string, string>) =>
				files.set('agents/agent-a/playbooks.json', JSON.stringify({ playbooks: [{ id: 'new' }] })),
			manifest: (manifest: { agents: Array<{ playbooks?: string }> }) => {
				manifest.agents[0].playbooks = 'agents/agent-a/playbooks.json';
			},
		};

		function seedEveryConflict(): void {
			writeJson(path.join(dataDir, 'maestro-sessions.json'), {
				sessions: [
					{
						id: 'agent-a',
						name: 'Alpha',
						toolType: 'claude-code',
						cwd: projRoot,
						projectRoot: projRoot,
					},
				],
			});
			writeJson(path.join(dataDir, 'playbooks', 'agent-a.json'), { playbooks: [{ id: 'old' }] });
			write(path.join(projRoot, '.maestro/prompts/tick.md'), 'Something else.');
			write(
				path.join(projRoot, '.maestro/cue.yaml'),
				yaml.dump({
					subscriptions: [
						{ name: 'tick', event: 'time.heartbeat', interval_minutes: 1, prompt: 'old' },
					],
				})
			);
		}

		it('collects every kind of conflict in one refusal', async () => {
			seedEveryConflict();
			const error = await refused(options(withPlaybooks));
			expect(error.code).toBe('CONFLICTS');
			const kinds = (error.details.conflicts as Array<{ kind: string }>).map((c) => c.kind).sort();
			expect(kinds).toEqual(['agent', 'file', 'playbooks', 'subscription']);
		});

		it('reports the same conflicts on a dry run and writes nothing', async () => {
			seedEveryConflict();
			const before = { data: snapshot(dataDir), proj: snapshot(projRoot) };
			const result = await importCueBundle(options(withPlaybooks, { dryRun: true }));
			expect(result.applied).toBe(false);
			expect(result.plan.conflicts).toHaveLength(4);
			expect({ data: snapshot(dataDir), proj: snapshot(projRoot) }).toEqual(before);
		});

		it('overwrites every conflict with force', async () => {
			seedEveryConflict();
			await importCueBundle(options(withPlaybooks, { force: true }));
			expect(fs.readFileSync(path.join(projRoot, '.maestro/prompts/tick.md'), 'utf-8')).toBe(
				'Tick.'
			);
			expect(
				JSON.parse(fs.readFileSync(path.join(dataDir, 'playbooks', 'agent-a.json'), 'utf-8'))
			).toEqual({ playbooks: [{ id: 'new' }] });
			const doc = yaml.load(fs.readFileSync(path.join(projRoot, '.maestro/cue.yaml'), 'utf-8')) as {
				subscriptions: Array<{ name: string; interval_minutes?: number }>;
			};
			expect(doc.subscriptions.find((s) => s.name === 'tick')?.interval_minutes).toBe(5);
			expect(doc.subscriptions.filter((s) => s.name === 'tick')).toHaveLength(1);
		});

		it('does not count a file with identical bytes as a conflict', async () => {
			write(path.join(projRoot, '.maestro/prompts/tick.md'), 'Tick.');
			const plan = await planCueBundleImport(options());
			expect(plan.conflicts).toEqual([]);
			expect(plan.files.find((f) => f.source.endsWith('tick.md'))?.action).toBe('unchanged');
		});
	});

	it('merges into an existing cue.yaml without disturbing its other pipelines', async () => {
		write(
			path.join(projRoot, '.maestro/cue.yaml'),
			'# Pipeline: Other (color: #00ff00)\n' +
				yaml.dump({
					subscriptions: [
						{
							name: 'other',
							event: 'time.heartbeat',
							interval_minutes: 30,
							prompt: 'unrelated',
							pipeline_name: 'Other',
						},
					],
				})
		);
		const result = await importCueBundle(options());
		expect(result.plan.cueConfigs[0]).toMatchObject({ created: false, added: ['tick', 'hook'] });

		const raw = fs.readFileSync(path.join(projRoot, '.maestro/cue.yaml'), 'utf-8');
		expect(raw.startsWith('# Pipeline: Other (color: #00ff00)\n')).toBe(true);
		const doc = yaml.load(raw) as {
			settings: Record<string, unknown>;
			subscriptions: Array<Record<string, unknown>>;
		};
		expect(doc.subscriptions.map((s) => s.name)).toEqual(['other', 'tick', 'hook']);
		expect(doc.subscriptions[0]).toEqual({
			name: 'other',
			event: 'time.heartbeat',
			interval_minutes: 30,
			prompt: 'unrelated',
			pipeline_name: 'Other',
		});
		expect(doc.settings.owner_agent_id).toBe('Alpha');
	});

	it('folds a legacy maestro-cue.yaml into the canonical file', async () => {
		write(
			path.join(projRoot, 'maestro-cue.yaml'),
			yaml.dump({
				subscriptions: [
					{ name: 'legacy', event: 'time.heartbeat', interval_minutes: 9, prompt: 'p' },
				],
			})
		);
		const result = await importCueBundle(options());
		expect(result.plan.cueConfigs[0].legacyRemoved).toBe(path.join(projRoot, 'maestro-cue.yaml'));
		expect(fs.existsSync(path.join(projRoot, 'maestro-cue.yaml'))).toBe(false);
		const doc = yaml.load(
			fs.readFileSync(
				path.join(projRoot, FIXTURE_CUE_PATH.replace('workspaces/proj/', '')),
				'utf-8'
			)
		) as {
			subscriptions: Array<{ name: string }>;
		};
		expect(doc.subscriptions.map((s) => s.name)).toEqual(['legacy', 'tick', 'hook']);
	});

	describe('provider binary paths', () => {
		const configsPath = () => path.join(dataDir, 'maestro-agent-configs.json');
		const binary = () => {
			const file = path.join(tmp, 'bin', 'claude');
			write(file, '#!/bin/sh\n');
			fs.chmodSync(file, 0o755);
			return file;
		};

		it('writes the binary as the provider path and keeps other provider settings', async () => {
			writeJson(configsPath(), {
				configs: { 'claude-code': { customArgs: '--verbose' } },
				other: 1,
			});
			const bin = binary();
			const result = await importCueBundle(options({}, { agentPaths: { 'claude-code': bin } }));
			expect(result.plan.agentPaths).toEqual([
				{ toolType: 'claude-code', path: bin, action: 'create' },
			]);
			const stored = JSON.parse(fs.readFileSync(configsPath(), 'utf-8'));
			expect(stored).toEqual({
				configs: { 'claude-code': { customArgs: '--verbose', customPath: bin } },
				other: 1,
			});
		});

		it('reports a different existing path as a conflict, and an equal one as unchanged', async () => {
			const bin = binary();
			writeJson(configsPath(), { configs: { 'claude-code': { customPath: '/old/claude' } } });
			const plan = await planCueBundleImport(options({}, { agentPaths: { 'claude-code': bin } }));
			expect(plan.conflicts).toEqual([
				{
					kind: 'agent-path',
					target: 'claude-code',
					message: 'claude-code already runs /old/claude',
				},
			]);
			expect(plan.agentPaths[0]).toMatchObject({ action: 'overwrite', previous: '/old/claude' });
			expect((await refused(options({}, { agentPaths: { 'claude-code': bin } }))).code).toBe(
				'CONFLICTS'
			);

			writeJson(configsPath(), { configs: { 'claude-code': { customPath: bin } } });
			const same = await planCueBundleImport(options({}, { agentPaths: { 'claude-code': bin } }));
			expect(same.conflicts).toEqual([]);
			expect(same.agentPaths[0].action).toBe('unchanged');
		});

		it('warns about a missing binary and a tool no agent runs', async () => {
			const plan = await planCueBundleImport(
				options({}, { agentPaths: { codex: path.join(tmp, 'nope', 'codex') } })
			);
			expect(plan.warnings.some((w) => w.includes('No agent in this bundle runs codex'))).toBe(
				true
			);
			expect(plan.warnings.some((w) => w.includes('missing or not executable'))).toBe(true);
		});

		it('refuses an unknown tool type or a relative path', async () => {
			expect((await refused(options({}, { agentPaths: { nope: '/bin/x' } }))).code).toBe(
				'INVALID_OPTIONS'
			);
			expect((await refused(options({}, { agentPaths: { codex: 'bin/codex' } }))).code).toBe(
				'INVALID_OPTIONS'
			);
		});

		it('rolls the provider path back with everything else', async () => {
			writeJson(configsPath(), { configs: { codex: { customArgs: '-q' } } });
			const before = fs.readFileSync(configsPath(), 'utf-8');
			vi.mocked(writeSessionsStoreFile).mockRejectedValueOnce(new Error('disk full'));
			const error = await importError(options({}, { agentPaths: { 'claude-code': binary() } }));
			expect(error.code).toBe('WRITE_FAILED');
			expect(fs.readFileSync(configsPath(), 'utf-8')).toBe(before);
		});
	});

	it('rolls every earlier write back when the agent records fail to write', async () => {
		const freshData = path.join(tmp, 'fresh-data');
		write(path.join(projRoot, '.maestro/cue.yaml'), yaml.dump({ subscriptions: [] }));
		const projBefore = snapshot(projRoot);
		vi.mocked(writeSessionsStoreFile).mockRejectedValueOnce(new Error('disk full'));

		const error = await importError(options({}, { dataDir: freshData }));

		expect(error.code).toBe('WRITE_FAILED');
		expect(error.details.rolledBack).toBe(true);
		expect(error.message).toContain('disk full');
		expect(snapshot(projRoot)).toEqual(projBefore);
		expect(fs.existsSync(freshData)).toBe(false);
	});
});
