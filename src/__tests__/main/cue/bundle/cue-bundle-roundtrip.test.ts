/**
 * The export -> import -> re-export loop, byte for byte.
 *
 * A bundle exported on one machine, imported into a clean data dir with its
 * workspaces checked out somewhere else, and exported again must be the same
 * zip. Anything that legitimately cannot survive the trip is pinned in the
 * last test with its reason, rather than loosened out of the first two.
 *
 * Things the round trip depends on by design, and so the fixtures hold fixed:
 *
 * - A workspace KEY is the slug of the local folder's name. Mapping `web` to
 *   `/srv/web-main` re-exports as `web-main`; the bundle has no other name for
 *   a project root, so the target folders keep their names here.
 * - A workspace's git `source` is read from the target checkout. The target
 *   gets the same `.git` (remote, branch, commit) a clone would have.
 * - A subscription with no `agent_id` and no `settings.owner_agent_id` runs on
 *   the first agent stored for its root, and a bundle does not carry the
 *   source machine's agent order. The fixtures name their owners.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { exportCueBundle } from '../../../../main/cue/bundle/cue-bundle-exporter';
import { importCueBundle } from '../../../../main/cue/bundle/cue-bundle-importer';
import { readZipArchive } from '../../../../main/utils/zip-archive';
import type { CueBundleManifest } from '../../../../shared/cue-bundle-types';

const PRODUCER = '0.18.0';
const COMMIT = 'c0ffee'.repeat(6) + 'c0ff';

let tmp: string;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cue-bundle-roundtrip-')));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function writeJson(file: string, value: unknown): void {
	write(file, JSON.stringify(value, null, '\t'));
}

/** What `git clone` of acme/web at COMMIT on `main` leaves in `.git`, as far as the exporter reads it. */
function fakeClone(root: string): void {
	write(
		path.join(root, '.git/config'),
		'[remote "origin"]\n\turl = https://github.com/acme/web.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'
	);
	write(path.join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
	write(path.join(root, '.git/refs/heads/main'), `${COMMIT}\n`);
}

function entries(zipPath: string): Map<string, string> {
	return new Map(
		readZipArchive(zipPath)
			.getEntries()
			.map((e) => [e.entryName, e.getData().toString('utf-8')])
	);
}

function manifestOf(zipPath: string): CueBundleManifest {
	return JSON.parse(entries(zipPath).get('manifest.json')!);
}

/**
 * Assert two zips are the same bytes. Compares entry by entry first, so a
 * failure names the file that drifted instead of two opaque hashes.
 */
function expectSameZip(a: string, b: string): void {
	expect(Object.fromEntries(entries(b))).toEqual(Object.fromEntries(entries(a)));
	expect(fs.readFileSync(b).equals(fs.readFileSync(a))).toBe(true);
}

interface Source {
	dataDir: string;
	webRoot: string;
	apiRoot: string;
}

/**
 * Two workspaces and three agents. The source roots sort `api` before `web`;
 * the target roots used below sort the other way.
 */
function seedSource(env: Record<string, string> = { LOG_LEVEL: 'debug' }, extra = {}): Source {
	const dataDir = path.join(tmp, 'source', 'data');
	const webRoot = path.join(tmp, 'source', 'z', 'web');
	const apiRoot = path.join(tmp, 'source', 'a', 'api');
	const outsideDocs = path.join(tmp, 'source', 'outside-docs');

	fakeClone(webRoot);
	write(path.join(webRoot, '.maestro/prompts/review.md'), 'Review the latest changes.\n');
	write(path.join(webRoot, '.maestro/prompts/docs.md'), 'Update the docs.\n');
	write(path.join(webRoot, '.maestro/playbooks/nightly.md'), '- [ ] nightly\n');
	write(path.join(apiRoot, '.maestro/playbooks/smoke.md'), '- [ ] smoke\n');
	write(path.join(outsideDocs, 'runbook.md'), '- [ ] run the book\n');
	fs.mkdirSync(path.join(webRoot, 'docs'), { recursive: true });

	write(
		path.join(webRoot, '.maestro/cue.yaml'),
		yaml.dump({
			settings: { owner_agent_id: 'agent-lead', timeout_minutes: 30 },
			subscriptions: [
				{
					name: 'review',
					event: 'time.heartbeat',
					agent_id: 'agent-lead',
					interval_minutes: 15,
					prompt_file: '.maestro/prompts/review.md',
					pipeline_name: 'Review',
				},
				{
					name: 'docs',
					event: 'agent.completed',
					agent_id: 'agent-docs',
					source_session: 'Lead',
					source_sub: 'review',
					prompt_file: '.maestro/prompts/docs.md',
					pipeline_name: 'Review',
				},
			],
		})
	);
	write(
		path.join(apiRoot, '.maestro/cue.yaml'),
		yaml.dump({
			settings: { owner_agent_id: 'agent-api' },
			subscriptions: [
				{
					name: 'api-check',
					event: 'agent.completed',
					agent_id: 'agent-api',
					source_session: 'Docs',
					source_sub: 'docs',
					prompt: 'Run the API checks.',
					pipeline_name: 'Review',
				},
			],
		})
	);

	writeJson(path.join(dataDir, 'maestro-sessions.json'), {
		sessions: [
			{
				id: 'agent-lead',
				name: 'Lead',
				toolType: 'claude-code',
				cwd: webRoot,
				projectRoot: webRoot,
				autoRunFolderPath: path.join(webRoot, '.maestro/playbooks'),
				customModel: 'opus',
				customEffort: 'high',
				customArgs: '--verbose',
				customContextWindow: 200000,
				newSessionMessage: 'Start by reading STATUS.md.',
				nudgeMessage: 'Keep it short.',
				enableMaestroP: true,
				maestroPMode: 'interactive',
				customEnvVars: env,
				...extra,
			},
			{
				id: 'agent-docs',
				name: 'Docs',
				toolType: 'codex',
				cwd: path.join(webRoot, 'docs'),
				projectRoot: webRoot,
				autoRunFolderPath: outsideDocs,
			},
			{
				id: 'agent-api',
				name: 'Api',
				toolType: 'claude-code',
				cwd: apiRoot,
				projectRoot: apiRoot,
				autoRunFolderPath: path.join(apiRoot, '.maestro/playbooks'),
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
				prompt: 'Work through the list.',
			},
		],
	});
	writeJson(path.join(dataDir, 'playbooks/agent-lead.json'), playbook('pb-lead', 'nightly'));
	writeJson(path.join(dataDir, 'playbooks/agent-docs.json'), playbook('pb-docs', 'runbook'));
	writeJson(path.join(dataDir, 'playbooks/agent-api.json'), playbook('pb-api', 'smoke'));
	writeJson(path.join(dataDir, 'cue-pipeline-layout.json'), {
		version: 2,
		pipelines: [
			{
				id: 'pipeline-review',
				name: 'Review',
				color: '#06b6d4',
				nodes: [{ id: 'n1', type: 'trigger', position: { x: 10, y: 20 }, data: { label: 'tick' } }],
				edges: [],
			},
		],
		selectedPipelineId: null,
		perProject: {},
	});
	return { dataDir, webRoot, apiRoot };
}

/** A clean server: an empty data dir path and the two projects checked out elsewhere. */
async function importInto(bundle: string, name: string): Promise<string> {
	const dataDir = path.join(tmp, name, 'data');
	const webRoot = path.join(tmp, name, 'a', 'web');
	const apiRoot = path.join(tmp, name, 'b', 'api');
	fakeClone(webRoot);
	fs.mkdirSync(path.join(webRoot, 'docs'), { recursive: true });
	fs.mkdirSync(apiRoot, { recursive: true });
	const workspaces: Record<string, string> = {};
	for (const ws of manifestOf(bundle).workspaces) {
		workspaces[ws.key] = ws.key === 'web' ? webRoot : apiRoot;
	}
	const result = await importCueBundle({
		bundlePath: bundle,
		dataDir,
		workspaces,
		runningVersion: PRODUCER,
		env: {},
	});
	expect(result.applied).toBe(true);
	return dataDir;
}

describe('bundle round trip', () => {
	it('re-exports a pipeline bundle byte for byte', async () => {
		const source = seedSource();
		const first = path.join(tmp, 'first.zip');
		await exportCueBundle({
			dataDir: source.dataDir,
			pipeline: 'Review',
			outputPath: first,
			producerVersion: PRODUCER,
		});
		expect(manifestOf(first).workspaces.map((w) => w.key)).toEqual(['api', 'web']);

		const target = await importInto(first, 'server');
		const second = path.join(tmp, 'second.zip');
		await exportCueBundle({
			dataDir: target,
			pipeline: 'Review',
			outputPath: second,
			producerVersion: PRODUCER,
		});

		expectSameZip(first, second);
	});

	it('re-exports an agent bundle byte for byte', async () => {
		const source = seedSource();
		const first = path.join(tmp, 'agent-first.zip');
		await exportCueBundle({
			dataDir: source.dataDir,
			agentId: 'agent-lead',
			outputPath: first,
			producerVersion: PRODUCER,
		});

		const target = await importInto(first, 'agent-server');
		const second = path.join(tmp, 'agent-second.zip');
		await exportCueBundle({
			dataDir: target,
			agentId: 'agent-lead',
			outputPath: second,
			producerVersion: PRODUCER,
		});

		expectSameZip(first, second);
	});

	/**
	 * What does NOT survive, and why. Each difference below is pinned exactly,
	 * so a new one fails this test instead of hiding in it.
	 *
	 * - Secret env vars (`ANTHROPIC_API_KEY`), values that look like a
	 *   credential (`DEPLOY_REF=ghp_...`) and machine paths
	 *   (`CLAUDE_CONFIG_DIR`) travel by NAME only. The importer reports them,
	 *   but an agent record has nowhere to keep a name without a value: a blank
	 *   value REMOVES the inherited variable on the desktop (`applyEnvRecord`)
	 *   and sets it to '' under Cue (`buildCueAgentEnvironment`), either of
	 *   which would block the secret the operator supplies through the
	 *   environment. So the re-export has no `env.required` /
	 *   `env.machineSpecific`, no `requirements.secrets`, and none of the
	 *   README lines or warnings derived from them.
	 * - SSH: the exporter drops the remote config and warns; the imported agent
	 *   is local, so the re-export has no SSH warning.
	 */
	it('loses only the names-without-values and the warnings about them', async () => {
		const source = seedSource(
			{
				LOG_LEVEL: 'debug',
				ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key',
				DEPLOY_REF: 'ghp_notarealtoken',
				CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
			},
			{ sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } }
		);
		const first = path.join(tmp, 'lossy-first.zip');
		await exportCueBundle({
			dataDir: source.dataDir,
			pipeline: 'Review',
			outputPath: first,
			producerVersion: PRODUCER,
		});
		const target = await importInto(first, 'lossy-server');
		const second = path.join(tmp, 'lossy-second.zip');
		await exportCueBundle({
			dataDir: target,
			pipeline: 'Review',
			outputPath: second,
			producerVersion: PRODUCER,
		});

		const a = entries(first);
		const b = entries(second);
		const changed = [...a.keys()].filter((k) => a.get(k) !== b.get(k)).sort();
		expect(changed).toEqual(['README.md', 'agents/agent-lead.json', 'manifest.json']);
		expect([...b.keys()].sort()).toEqual([...a.keys()].sort());

		// The agent keeps its exportable values and loses only the names.
		const leadA = JSON.parse(a.get('agents/agent-lead.json')!);
		const leadB = JSON.parse(b.get('agents/agent-lead.json')!);
		expect(leadA.env).toEqual({
			values: { LOG_LEVEL: 'debug' },
			required: ['ANTHROPIC_API_KEY', 'DEPLOY_REF'],
			machineSpecific: ['CLAUDE_CONFIG_DIR'],
		});
		expect(leadB.env).toEqual({ values: { LOG_LEVEL: 'debug' } });
		expect({ ...leadB, env: leadA.env }).toEqual(leadA);

		// The manifest differs in the secrets, the warnings, and the hashes and
		// sizes of the three files above. Nothing else.
		const mA = manifestOf(first);
		const mB = manifestOf(second);
		expect(mA.requirements.secrets).toEqual(['ANTHROPIC_API_KEY', 'DEPLOY_REF']);
		expect(mB.requirements.secrets).toEqual([]);
		expect(mA.warnings).toEqual([
			'Agent "Lead" runs over SSH on the exporting machine; its remote configuration was not exported.',
			'Agent "Lead" sets CLAUDE_CONFIG_DIR to a local path; set it again after import.',
			'Agent "Lead" sets DEPLOY_REF to a value that looks like a credential; it was exported by name only. Set it again after import.',
		]);
		expect(mB.warnings).toBeUndefined();
		const strip = (m: CueBundleManifest) => ({
			...m,
			requirements: { ...m.requirements, secrets: [] },
			warnings: undefined,
			files: m.files.filter((f) => !changed.includes(f.path)),
		});
		expect(strip(mB)).toEqual(strip(mA));
	});
});
