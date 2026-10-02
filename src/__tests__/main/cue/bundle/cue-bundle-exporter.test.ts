/**
 * Bundle exporter, exercised against real files in a temp directory: a data
 * dir (sessions, agent configs, playbooks, pipeline layout) and project roots
 * holding `.maestro/cue.yaml`, prompt files, and Auto Run documents. The zip
 * is read back and checked entry by entry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as yaml from 'js-yaml';
import {
	assignWorkspaceKeys,
	exportCueBundle,
	scrubGitRemote,
} from '../../../../main/cue/bundle/cue-bundle-exporter';
import { readZipArchive } from '../../../../main/utils/zip-archive';
import type {
	CueBundleAgentSettings,
	CueBundleManifest,
} from '../../../../shared/cue-bundle-types';

const SECRET_VALUE = 'sk-ant-super-secret-value-1234';
const PARKED_VALUE = 'parked-value-should-never-appear';

let tmp: string;
let dataDir: string;
let alphaRoot: string;
let betaRoot: string;

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function writeJson(file: string, value: unknown): void {
	write(file, JSON.stringify(value, null, '\t'));
}

function writeCueYaml(root: string, doc: unknown): void {
	write(path.join(root, '.maestro/cue.yaml'), yaml.dump(doc));
}

function readZip(file: string): Map<string, Buffer> {
	const zip = readZipArchive(file);
	return new Map(zip.getEntries().map((e) => [e.entryName, e.getData()]));
}

function manifestOf(entries: Map<string, Buffer>): CueBundleManifest {
	return JSON.parse(entries.get('manifest.json')!.toString('utf-8'));
}

/**
 * Three agents across two project roots: `alpha` and `writer` share the
 * alpha root, `beta` has its own. Pipeline "Review" spans all three.
 */
function seed(): void {
	alphaRoot = path.join(tmp, 'projects', 'alpha');
	betaRoot = path.join(tmp, 'projects', 'beta');

	writeJson(path.join(dataDir, 'maestro-sessions.json'), {
		sessions: [
			{
				id: 'agent-alpha',
				name: 'Alpha',
				toolType: 'claude-code',
				cwd: alphaRoot,
				projectRoot: alphaRoot,
				fullPath: alphaRoot,
				customPath: '/opt/local/bin/claude',
				autoRunFolderPath: path.join(alphaRoot, '.maestro/playbooks'),
				customModel: 'opus',
				customEnvVars: {
					ANTHROPIC_API_KEY: SECRET_VALUE,
					LOG_LEVEL: 'debug',
					CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
				},
				customEnvVarsDisabled: { PARKED_VAR: PARKED_VALUE },
			},
			{
				id: 'agent-writer',
				name: 'Writer',
				toolType: 'codex',
				cwd: path.join(alphaRoot, 'docs'),
				projectRoot: alphaRoot,
				autoRunFolderPath: path.join(tmp, 'outside-docs'),
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
			},
			{
				id: 'agent-beta',
				name: 'Beta',
				toolType: 'claude-code',
				cwd: betaRoot,
				projectRoot: betaRoot,
			},
			{
				id: 'agent-unrelated',
				name: 'Unrelated',
				toolType: 'claude-code',
				cwd: path.join(tmp, 'projects', 'gamma'),
				projectRoot: path.join(tmp, 'projects', 'gamma'),
			},
		],
	});
	writeJson(path.join(dataDir, 'maestro-agent-configs.json'), {
		configs: { codex: { customEnvVars: { OPENAI_API_KEY: SECRET_VALUE, REGION: 'eu' } } },
	});
	writeJson(path.join(dataDir, 'playbooks', 'agent-alpha.json'), {
		playbooks: [
			{
				id: 'pb1',
				name: 'Nightly',
				createdAt: 1,
				updatedAt: 2,
				documents: [{ filename: 'nightly', resetOnCompletion: false }],
				loopEnabled: false,
				prompt: 'Do the tasks',
			},
		],
	});
	writeJson(path.join(dataDir, 'playbooks', 'agent-writer.json'), {
		playbooks: [
			{
				id: 'pb2',
				name: 'Write',
				createdAt: 1,
				updatedAt: 2,
				documents: [{ filename: 'draft', resetOnCompletion: true }],
				loopEnabled: false,
				prompt: 'Write',
			},
		],
	});
	writeJson(path.join(dataDir, 'cue-pipeline-layout.json'), {
		version: 2,
		selectedPipelineId: null,
		pipelines: [
			{ id: 'p-review', name: 'Review', color: '#06b6d4', nodes: [{ id: 'n1' }], edges: [] },
			{ id: 'p-other', name: 'Other', color: '#ff0000', nodes: [], edges: [] },
		],
	});

	// Alpha root: a git checkout with a credentialed remote.
	write(
		path.join(alphaRoot, '.git/config'),
		'[core]\n\tbare = false\n[remote "origin"]\n\turl = https://ghp_token123@github.com/acme/alpha.git\n'
	);
	write(path.join(alphaRoot, '.git/HEAD'), 'ref: refs/heads/main\n');
	write(path.join(alphaRoot, '.maestro/prompts/review.md'), 'Review the PR.');
	write(path.join(alphaRoot, '.maestro/playbooks/nightly.md'), '- [ ] nightly task');
	write(path.join(alphaRoot, '.maestro/playbooks/extra.md'), '- [ ] extra doc');
	write(path.join(tmp, 'outside-docs/draft.md'), '- [ ] draft');
	writeCueYaml(alphaRoot, {
		settings: { timeout_minutes: 15, owner_agent_id: 'Alpha' },
		subscriptions: [
			{
				name: 'review-pr',
				event: 'github.pull_request',
				agent_id: 'agent-alpha',
				pipeline_name: 'Review',
				prompt_file: '.maestro/prompts/review.md',
				fan_out: ['Writer'],
				fan_out_ids: ['agent-writer'],
			},
			{
				name: 'hook',
				event: 'webhook.received',
				agent_id: 'agent-writer',
				pipeline_name: 'Review',
				prompt: 'Handle it',
				webhook: { path: 'hook', secret_env: 'HOOK_SECRET' },
			},
			{
				name: 'other-pipeline',
				event: 'time.heartbeat',
				agent_id: 'agent-alpha',
				pipeline_name: 'Other',
				prompt: 'tick',
				interval_minutes: 5,
			},
		],
	});

	write(path.join(betaRoot, '.maestro/prompts/chain.md'), 'Continue.');
	writeCueYaml(betaRoot, {
		subscriptions: [
			{
				name: 'chain',
				event: 'agent.completed',
				agent_id: 'agent-beta',
				pipeline_name: 'Review',
				source_session: ['Alpha'],
				source_session_ids: ['agent-alpha'],
				prompt_file: path.join(betaRoot, '.maestro/prompts/chain.md'),
			},
		],
	});
}

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cue-bundle-')));
	dataDir = path.join(tmp, 'data');
	seed();
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

const ENV = {} as NodeJS.ProcessEnv;

describe('exportCueBundle - pipeline', () => {
	it('exports every referenced agent, one workspace per project root, and the layout entry', async () => {
		const out = path.join(tmp, 'out', 'review.zip');
		const result = await exportCueBundle({
			dataDir,
			pipeline: 'Review',
			outputPath: out,
			env: ENV,
		});
		const entries = readZip(out);
		const manifest = manifestOf(entries);

		expect(manifest.bundleVersion).toBe(1);
		expect(manifest.kind).toBe('maestro-pipeline');
		expect(manifest.minEngineVersion).toBe('0.18.0');
		expect(manifest.createdAt).toBeUndefined();
		expect(manifest.agents.map((a) => a.id)).toEqual(['agent-alpha', 'agent-beta', 'agent-writer']);
		expect(manifest.workspaces.map((w) => w.key)).toEqual(['alpha', 'beta']);
		expect(manifest.agents.find((a) => a.id === 'agent-writer')?.workspace).toBe('alpha');
		expect(result.manifest).toEqual(manifest);

		// Only the matching pipeline's layout entry.
		const layout = JSON.parse(entries.get('layout/pipeline.json')!.toString('utf-8'));
		expect(layout.id).toBe('p-review');

		// Only the pipeline's subscriptions, plus the settings block.
		const alphaCue = yaml.load(
			entries.get('workspaces/alpha/.maestro/cue.yaml')!.toString('utf-8')
		) as { settings: Record<string, unknown>; subscriptions: Array<Record<string, unknown>> };
		expect(alphaCue.settings.timeout_minutes).toBe(15);
		expect(alphaCue.subscriptions.map((s) => s.name)).toEqual(['review-pr', 'hook']);
		expect(entries.get('workspaces/alpha/.maestro/prompts/review.md')!.toString()).toBe(
			'Review the PR.'
		);

		// An absolute prompt_file inside the root is rewritten relative.
		const betaCue = yaml.load(
			entries.get('workspaces/beta/.maestro/cue.yaml')!.toString('utf-8')
		) as { subscriptions: Array<Record<string, unknown>> };
		expect(betaCue.subscriptions[0].prompt_file).toBe('.maestro/prompts/chain.md');
		expect(entries.has('workspaces/beta/.maestro/prompts/chain.md')).toBe(true);

		// Playbook docs: inside the workspace vs outside it.
		expect(entries.has('workspaces/alpha/.maestro/playbooks/nightly.md')).toBe(true);
		expect(entries.has('autorun/agent-writer/draft.md')).toBe(true);
		// Pipeline mode copies only documents a playbook references.
		expect(entries.has('workspaces/alpha/.maestro/playbooks/extra.md')).toBe(false);

		expect(manifest.requirements).toEqual({
			events: ['agent.completed', 'github.pull_request', 'webhook.received'],
			tools: ['gh', 'git'],
			secrets: ['ANTHROPIC_API_KEY', 'HOOK_SECRET', 'OPENAI_API_KEY'],
		});
		expect(manifest.warnings?.some((w) => w.includes('Writer') && w.includes('SSH'))).toBe(true);
		expect(entries.get('README.md')!.toString()).toContain('HOOK_SECRET');
	});

	it('records checksums and sizes that match the stored bytes', async () => {
		const out = path.join(tmp, 'review.zip');
		await exportCueBundle({ dataDir, pipeline: 'Review', outputPath: out, env: ENV });
		const entries = readZip(out);
		const manifest = manifestOf(entries);

		expect(manifest.files.map((f) => f.path)).toEqual(
			[...entries.keys()].filter((p) => p !== 'manifest.json').sort()
		);
		for (const file of manifest.files) {
			const bytes = entries.get(file.path)!;
			expect(file.size).toBe(bytes.length);
			expect(file.sha256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
		}
	});

	it('never writes a secret or parked value', async () => {
		const out = path.join(tmp, 'review.zip');
		await exportCueBundle({ dataDir, pipeline: 'Review', outputPath: out, env: ENV });
		const entries = readZip(out);
		for (const [name, bytes] of entries) {
			const text = bytes.toString('utf-8');
			expect(text, name).not.toContain(SECRET_VALUE);
			expect(text, name).not.toContain(PARKED_VALUE);
			expect(text, name).not.toContain('PARKED_VAR');
		}
		const alpha = JSON.parse(
			entries.get('agents/agent-alpha.json')!.toString('utf-8')
		) as CueBundleAgentSettings;
		expect(alpha.env).toEqual({
			values: { LOG_LEVEL: 'debug' },
			required: ['ANTHROPIC_API_KEY'],
			machineSpecific: ['CLAUDE_CONFIG_DIR'],
		});
		// The provider-level env applies when the agent has none of its own.
		const writer = JSON.parse(
			entries.get('agents/agent-writer.json')!.toString('utf-8')
		) as CueBundleAgentSettings;
		expect(writer.env).toEqual({ values: { REGION: 'eu' }, required: ['OPENAI_API_KEY'] });
		expect(writer.cwd).toBe('docs');
	});

	it('leaks no absolute local path', async () => {
		const out = path.join(tmp, 'review.zip');
		await exportCueBundle({ dataDir, pipeline: 'Review', outputPath: out, env: ENV });
		const entries = readZip(out);
		const needles = [tmp, JSON.stringify(tmp).slice(1, -1), '/opt/local/bin/claude', os.homedir()];
		for (const [name, bytes] of entries) {
			const text = bytes.toString('utf-8');
			for (const needle of needles) expect(text, name).not.toContain(needle);
		}
	});

	it('scrubs credentials from the git remote', async () => {
		const out = path.join(tmp, 'review.zip');
		await exportCueBundle({ dataDir, pipeline: 'Review', outputPath: out, env: ENV });
		const manifest = manifestOf(readZip(out));
		const alpha = manifest.workspaces.find((w) => w.key === 'alpha');
		expect(alpha?.source).toEqual({
			gitRemote: 'https://github.com/acme/alpha.git',
			gitBranch: 'main',
		});
		expect(JSON.stringify(manifest)).not.toContain('ghp_token123');
	});

	it('produces byte-identical archives for the same data', async () => {
		const a = path.join(tmp, 'a.zip');
		const b = path.join(tmp, 'b.zip');
		const first = await exportCueBundle({ dataDir, pipeline: 'Review', outputPath: a, env: ENV });
		const second = await exportCueBundle({ dataDir, pipeline: 'Review', outputPath: b, env: ENV });
		expect(fs.readFileSync(a).equals(fs.readFileSync(b))).toBe(true);
		expect(first.sha256).toBe(second.sha256);
	});

	it('records createdAt only when pinned', async () => {
		const out = path.join(tmp, 'pinned.zip');
		await exportCueBundle({
			dataDir,
			pipeline: 'Review',
			outputPath: out,
			env: { SOURCE_DATE_EPOCH: '1767225600' } as NodeJS.ProcessEnv,
		});
		expect(manifestOf(readZip(out)).createdAt).toBe('2026-01-01T00:00:00.000Z');

		await exportCueBundle({
			dataDir,
			pipeline: 'Review',
			outputPath: out,
			createdAt: '2026-03-04T05:06:07Z',
			env: { SOURCE_DATE_EPOCH: '1767225600' } as NodeJS.ProcessEnv,
		});
		expect(manifestOf(readZip(out)).createdAt).toBe('2026-03-04T05:06:07.000Z');
	});

	it('rejects a prompt file that escapes the project root', async () => {
		write(path.join(tmp, 'secret.md'), 'host file');
		writeCueYaml(betaRoot, {
			subscriptions: [
				{
					name: 'chain',
					event: 'agent.completed',
					agent_id: 'agent-beta',
					pipeline_name: 'Review',
					prompt_file: '../../secret.md',
				},
			],
		});
		await expect(
			exportCueBundle({
				dataDir,
				pipeline: 'Review',
				outputPath: path.join(tmp, 'x.zip'),
				env: ENV,
			})
		).rejects.toThrow(/escapes its project root/);
		expect(fs.existsSync(path.join(tmp, 'x.zip'))).toBe(false);
	});

	it.skipIf(process.platform === 'win32')(
		'rejects a prompt file that escapes through a symlink',
		async () => {
			write(path.join(tmp, 'secret.md'), 'host file');
			fs.symlinkSync(path.join(tmp, 'secret.md'), path.join(betaRoot, '.maestro/prompts/link.md'));
			writeCueYaml(betaRoot, {
				subscriptions: [
					{
						name: 'chain',
						event: 'agent.completed',
						agent_id: 'agent-beta',
						pipeline_name: 'Review',
						prompt_file: '.maestro/prompts/link.md',
					},
				],
			});
			await expect(
				exportCueBundle({
					dataDir,
					pipeline: 'Review',
					outputPath: path.join(tmp, 'x.zip'),
					env: ENV,
				})
			).rejects.toThrow(/symlink outside its project root/);
		}
	);

	it('refuses a literal webhook.secret unless allowed', async () => {
		writeCueYaml(betaRoot, {
			subscriptions: [
				{
					name: 'inline',
					event: 'webhook.received',
					agent_id: 'agent-beta',
					pipeline_name: 'Review',
					prompt: 'go',
					webhook: { secret: 'literal-hook-secret' },
				},
			],
		});
		const out = path.join(tmp, 'inline.zip');
		await expect(
			exportCueBundle({ dataDir, pipeline: 'Review', outputPath: out, env: ENV })
		).rejects.toThrow(/literal webhook\.secret/);

		const result = await exportCueBundle({
			dataDir,
			pipeline: 'Review',
			outputPath: out,
			allowInlineSecrets: true,
			env: ENV,
		});
		expect(result.manifest.warnings?.some((w) => w.includes('literal webhook secret'))).toBe(true);
	});

	it('fails on an unknown pipeline', async () => {
		await expect(
			exportCueBundle({ dataDir, pipeline: 'Nope', outputPath: path.join(tmp, 'n.zip'), env: ENV })
		).rejects.toThrow(/Pipeline not found: Nope/);
	});
});

describe('exportCueBundle - single agent', () => {
	it('exports the agent, its playbooks, every Auto Run document, and only its own subscriptions', async () => {
		const out = path.join(tmp, 'alpha.zip');
		const result = await exportCueBundle({
			dataDir,
			agentId: 'agent-alpha',
			outputPath: out,
			env: ENV,
		});
		const entries = readZip(out);
		const manifest = manifestOf(entries);

		expect(manifest.kind).toBe('maestro-agent');
		expect(manifest.name).toBe('Alpha');
		expect(manifest.agents.map((a) => a.id)).toEqual(['agent-alpha']);
		expect(manifest.workspaces.map((w) => w.key)).toEqual(['alpha']);
		expect(entries.has('layout/pipeline.json')).toBe(false);

		const playbooks = JSON.parse(entries.get('agents/agent-alpha/playbooks.json')!.toString());
		expect(playbooks.playbooks[0].name).toBe('Nightly');
		expect(entries.has('workspaces/alpha/.maestro/playbooks/nightly.md')).toBe(true);
		expect(entries.has('workspaces/alpha/.maestro/playbooks/extra.md')).toBe(true);

		const settings = JSON.parse(
			entries.get('agents/agent-alpha.json')!.toString()
		) as CueBundleAgentSettings;
		expect(settings.autoRun).toEqual({ workspace: 'alpha', path: '.maestro/playbooks' });
		expect(settings.customModel).toBe('opus');
		expect(settings).not.toHaveProperty('customPath');

		const cue = yaml.load(entries.get('workspaces/alpha/.maestro/cue.yaml')!.toString()) as {
			subscriptions: Array<{ name: string }>;
		};
		expect(cue.subscriptions.map((s) => s.name)).toEqual(['review-pr', 'other-pipeline']);
		expect(result.manifest.warnings?.some((w) => w.includes('Writer'))).toBe(true);
	});

	it('copies documents of a folder outside the workspace under autorun/', async () => {
		const out = path.join(tmp, 'writer.zip');
		await exportCueBundle({ dataDir, agentId: 'agent-writer', outputPath: out, env: ENV });
		const entries = readZip(out);
		expect(entries.has('autorun/agent-writer/draft.md')).toBe(true);
		const settings = JSON.parse(
			entries.get('agents/agent-writer.json')!.toString()
		) as CueBundleAgentSettings;
		expect(settings.autoRun).toEqual({ bundlePath: 'autorun/agent-writer' });
	});

	it('requires exactly one of agent or pipeline', async () => {
		const outputPath = path.join(tmp, 'x.zip');
		await expect(exportCueBundle({ dataDir, outputPath, env: ENV })).rejects.toThrow(/exactly one/);
		await expect(
			exportCueBundle({ dataDir, outputPath, agentId: 'agent-alpha', pipeline: 'Review', env: ENV })
		).rejects.toThrow(/exactly one/);
	});

	it('fails on an unknown agent id', async () => {
		await expect(
			exportCueBundle({ dataDir, agentId: 'ghost', outputPath: path.join(tmp, 'g.zip'), env: ENV })
		).rejects.toThrow(/Agent not found: ghost/);
	});
});

describe('exportCueBundle - data directory', () => {
	it('reads only from the given data directory', async () => {
		const otherData = path.join(tmp, 'other-data');
		writeJson(path.join(otherData, 'maestro-sessions.json'), {
			sessions: [
				{
					id: 'agent-solo',
					name: 'Solo',
					toolType: 'claude-code',
					cwd: betaRoot,
					projectRoot: betaRoot,
				},
			],
		});
		const out = path.join(tmp, 'solo.zip');
		const result = await exportCueBundle({
			dataDir: otherData,
			agentId: 'agent-solo',
			outputPath: out,
			env: ENV,
		});
		expect(result.manifest.agents.map((a) => a.name)).toEqual(['Solo']);
		await expect(
			exportCueBundle({ dataDir: otherData, agentId: 'agent-alpha', outputPath: out, env: ENV })
		).rejects.toThrow(/Agent not found/);
	});
});

describe('helpers', () => {
	it('assigns deterministic workspace keys with collision suffixes', () => {
		const keys = assignWorkspaceKeys(['/z/app', '/a/app', '/m/My Project', '/b/app']);
		expect(keys.get('/a/app')).toBe('app');
		expect(keys.get('/b/app')).toBe('app-2');
		expect(keys.get('/z/app')).toBe('app-3');
		expect(keys.get('/m/My Project')).toBe('my-project');
	});

	it('scrubs userinfo from remotes', () => {
		expect(scrubGitRemote('https://token@github.com/o/r.git')).toBe('https://github.com/o/r.git');
		expect(scrubGitRemote('https://user:pass@gitlab.com/o/r')).toBe('https://gitlab.com/o/r');
		expect(scrubGitRemote('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
		expect(scrubGitRemote('ssh://git:pw@host/o/r')).toBe('ssh://git@host/o/r');
	});
});
