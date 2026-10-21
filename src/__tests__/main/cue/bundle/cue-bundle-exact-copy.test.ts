/**
 * Exact copies: export an agent, delete it, import it, and get the same agent.
 *
 * An exact copy (`includeLocal`) carries `local.json` with what a portable
 * bundle leaves out: secret values, binary paths, SSH and other providers'
 * settings, and the folders it lived in. Also covers the export options the
 * Left Bar's Export Agent dialog adds (`includeCue`) and the group an import
 * puts new agents in.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { exportCueBundle } from '../../../../main/cue/bundle/cue-bundle-exporter';
import {
	CueBundleImportError,
	importCueBundle,
	planCueBundleImport,
} from '../../../../main/cue/bundle/cue-bundle-importer';
import {
	readCueBundleArchive,
	validateCueBundleArchive,
} from '../../../../main/cue/bundle/cue-bundle-validator';
import { readSessionsStoreFile } from '../../../../main/stores/sessions-store-file';
import { readZipArchive } from '../../../../main/utils/zip-archive';
import {
	CUE_BUNDLE_LOCAL_AGENT_FIELDS,
	type CueBundleLocalData,
	type CueBundleManifest,
} from '../../../../shared/cue-bundle-types';
import type { SessionInfo } from '../../../../shared/types';
import { writeCueBundle } from '../../../helpers/cueBundleFixture';

const VERSION = '0.18.0';

let tmp: string;
let dataDir: string;
let webRoot: string;
let outsideDocs: string;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cue-bundle-exact-')));
	dataDir = path.join(tmp, 'data');
	webRoot = path.join(tmp, 'projects', 'web');
	outsideDocs = path.join(tmp, 'outside-docs');
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function writeSessions(sessions: Array<Record<string, unknown>>): void {
	write(path.join(dataDir, 'maestro-sessions.json'), JSON.stringify({ sessions }, null, '\t'));
}

/** The agent as it was before the export: everything a user can set on it. */
function leadAgent(): Record<string, unknown> {
	return {
		id: 'agent-lead',
		name: 'Lead',
		toolType: 'claude-code',
		cwd: webRoot,
		projectRoot: webRoot,
		autoRunFolderPath: outsideDocs,
		customModel: 'opus',
		customEffort: 'high',
		customEnvVars: { LOG_LEVEL: 'debug', API_TOKEN: 'sk-live-123', TOOLS_DIR: '/opt/tools' },
		customEnvVarsDisabled: { OLD_FLAG: '1' },
		customPath: '/usr/local/bin/claude',
		sessionSshRemoteConfig: { enabled: false, remoteId: 'remote-1' },
		additionalDirectories: [{ path: '/srv/shared', read: true, write: false }],
		worktreeConfig: { basePath: '/srv/worktrees', watchEnabled: true },
		providerOverrides: { codex: { customModel: 'gpt-5', customPath: '/opt/codex' } },
		bookmarked: true,
		retryOnTokenExhaustion: false,
		fileTreeAutoRefreshInterval: 30,
		contextWindowSource: 'user-edited',
		customContextWindow: 200000,
	};
}

function seed(): void {
	write(path.join(webRoot, '.maestro/prompts/review.md'), 'Review it.\n');
	write(path.join(outsideDocs, 'runbook.md'), '- [ ] run the book\n');
	write(
		path.join(webRoot, '.maestro/cue.yaml'),
		yaml.dump({
			subscriptions: [
				{
					name: 'review',
					event: 'time.heartbeat',
					agent_id: 'agent-lead',
					interval_minutes: 15,
					prompt_file: '.maestro/prompts/review.md',
				},
			],
		})
	);
	writeSessions([leadAgent()]);
}

function entries(zipPath: string): Map<string, string> {
	return new Map(
		readZipArchive(zipPath)
			.getEntries()
			.map((e) => [e.entryName, e.getData().toString('utf-8')])
	);
}

async function exportLead(options: { includeLocal?: boolean; includeCue?: boolean } = {}) {
	const outputPath = path.join(tmp, 'lead.zip');
	await exportCueBundle({
		dataDir,
		agentId: 'agent-lead',
		outputPath,
		producerVersion: VERSION,
		env: {},
		claudeConfigDir: path.join(tmp, 'claude'),
		...options,
	});
	return outputPath;
}

function importOptions(bundlePath: string, extra: Record<string, unknown> = {}) {
	return {
		bundlePath,
		dataDir,
		workspaces: {},
		runningVersion: VERSION,
		env: {},
		runSecretsDir: null,
		claudeConfigDir: path.join(tmp, 'claude'),
		...extra,
	};
}

function storedAgent(): SessionInfo & Record<string, unknown> {
	const agent = readSessionsStoreFile(dataDir).sessions.find((s) => s.id === 'agent-lead');
	expect(agent).toBeDefined();
	return agent as SessionInfo & Record<string, unknown>;
}

describe('exact copy export', () => {
	it('writes local.json with the machine data and keeps every other file free of local paths', async () => {
		seed();
		const zip = await exportLead({ includeLocal: true });
		const files = entries(zip);
		const manifest = JSON.parse(files.get('manifest.json')!) as CueBundleManifest;

		expect(manifest.local).toBe('local.json');
		const local = JSON.parse(files.get('local.json')!) as CueBundleLocalData;
		expect(local.workspaces).toEqual({ web: webRoot });
		expect(local.agents['agent-lead']).toEqual({
			customEnvVars: { LOG_LEVEL: 'debug', API_TOKEN: 'sk-live-123', TOOLS_DIR: '/opt/tools' },
			customEnvVarsDisabled: { OLD_FLAG: '1' },
			customPath: '/usr/local/bin/claude',
			sessionSshRemoteConfig: { enabled: false, remoteId: 'remote-1' },
			additionalDirectories: [{ path: '/srv/shared', read: true, write: false }],
			worktreeConfig: { basePath: '/srv/worktrees', watchEnabled: true },
			providerOverrides: { codex: { customModel: 'gpt-5', customPath: '/opt/codex' } },
			bookmarked: true,
			autoRunFolderPath: outsideDocs,
		});

		for (const [name, text] of files) {
			if (name === 'local.json') continue;
			expect(text.includes(tmp), `${name} names a local path`).toBe(false);
		}
		expect(files.get('README.md')).toContain('## Exact copy');
		const archive = readCueBundleArchive(zip);
		expect(validateCueBundleArchive(archive, { runningVersion: VERSION }).errors).toEqual([]);
	});

	it('leaves the "set it again" warnings out, since the copy carries those values', async () => {
		seed();
		const portable = JSON.parse(entries(await exportLead()).get('manifest.json')!);
		// A secret recognized by its name is a stated requirement, not a warning.
		expect(portable.requirements.secrets).toContain('API_TOKEN');
		expect(portable.warnings.join('\n')).toMatch(/TOOLS_DIR/);

		const exact = JSON.parse(
			entries(await exportLead({ includeLocal: true })).get('manifest.json')!
		);
		expect((exact.warnings ?? []).join('\n')).not.toMatch(/API_TOKEN|TOOLS_DIR/);
	});

	it('exports the agent settings a portable bundle can carry', async () => {
		seed();
		const settings = JSON.parse(entries(await exportLead()).get('agents/agent-lead.json')!);
		expect(settings).toMatchObject({
			retryOnTokenExhaustion: false,
			fileTreeAutoRefreshInterval: 30,
			contextWindowSource: 'user-edited',
			customContextWindow: 200000,
		});
		expect(settings).not.toHaveProperty('customPath');
		expect(settings).not.toHaveProperty('bookmarked');
	});

	it('leaves the Cue subscriptions out when asked', async () => {
		seed();
		const files = entries(await exportLead({ includeCue: false }));
		const manifest = JSON.parse(files.get('manifest.json')!) as CueBundleManifest;
		expect(manifest.workspaces[0].cueConfig).toBeUndefined();
		expect([...files.keys()].some((name) => name.endsWith('cue.yaml'))).toBe(false);
		expect(manifest.requirements.events).toEqual([]);
	});

	it('refuses a pipeline export without its Cue subscriptions', async () => {
		seed();
		await expect(
			exportCueBundle({
				dataDir,
				pipeline: 'Review',
				outputPath: path.join(tmp, 'p.zip'),
				includeCue: false,
			})
		).rejects.toThrow(/always carries its Cue subscriptions/);
	});
});

describe('exact copy import', () => {
	it('gives back the same agent after it was deleted, in the group asked for', async () => {
		seed();
		const zip = await exportLead({ includeLocal: true });
		writeSessions([]);
		fs.rmSync(path.join(outsideDocs, 'runbook.md'));

		const result = await importCueBundle(importOptions(zip, { groupId: 'group-1' }));

		expect(result.plan.local).toEqual({
			applied: true,
			workspaces: { web: webRoot },
			agents: [
				{
					agentId: 'agent-lead',
					agentName: 'Lead',
					fields: CUE_BUNDLE_LOCAL_AGENT_FIELDS.filter(
						(f) => f !== 'customProviderPath' && f !== 'maestroPPath'
					),
					binaries: ['/usr/local/bin/claude'],
				},
			],
		});
		const agent = storedAgent();
		const original = leadAgent();
		for (const field of Object.keys(original)) {
			expect(agent[field], field).toEqual(original[field]);
		}
		expect(agent.groupId).toBe('group-1');
		expect(agent.requiredSecrets).toBeUndefined();
		// Auto Run documents go back to the folder they came from.
		expect(fs.readFileSync(path.join(outsideDocs, 'runbook.md'), 'utf-8')).toBe(
			'- [ ] run the book\n'
		);
		expect(fs.existsSync(path.join(dataDir, 'autorun'))).toBe(false);
	});

	it('reports a secret the copy carries as set', async () => {
		seed();
		const zip = await exportLead({ includeLocal: true });
		writeSessions([]);
		const plan = await planCueBundleImport(importOptions(zip));
		expect(plan.secrets.find((s) => s.name === 'API_TOKEN')).toMatchObject({
			set: true,
			source: 'bundle',
		});
	});

	it('imports like a portable bundle when the machine data is declined', async () => {
		seed();
		const zip = await exportLead({ includeLocal: true });
		writeSessions([]);

		await expect(importCueBundle(importOptions(zip, { useLocal: false }))).rejects.toMatchObject({
			code: 'WORKSPACE_UNMAPPED',
		});

		const result = await importCueBundle(
			importOptions(zip, { useLocal: false, workspaces: { web: webRoot } })
		);
		expect(result.plan.local?.applied).toBe(false);
		const agent = storedAgent();
		expect(agent.customPath).toBeUndefined();
		expect(agent.bookmarked).toBeUndefined();
		expect(agent.requiredSecrets).toEqual(['API_TOKEN']);
		expect(agent.customEnvVars).toEqual({ LOG_LEVEL: 'debug' });
		expect(agent.fileTreeAutoRefreshInterval).toBe(30);
	});

	it('maps a workspace the caller names over the folder the copy came from', async () => {
		seed();
		const zip = await exportLead({ includeLocal: true });
		writeSessions([]);
		const elsewhere = path.join(tmp, 'elsewhere', 'web');
		fs.mkdirSync(elsewhere, { recursive: true });

		const plan = await planCueBundleImport(importOptions(zip, { workspaces: { web: elsewhere } }));
		expect(plan.local?.workspaces).toEqual({});
		expect(plan.agents[0].cwd).toBe(elsewhere);
	});

	it('skips a copied folder that no longer exists and asks for one instead', async () => {
		seed();
		const zip = await exportLead({ includeLocal: true });
		writeSessions([]);
		fs.rmSync(webRoot, { recursive: true });

		const error = await importCueBundle(importOptions(zip)).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CueBundleImportError);
		expect((error as CueBundleImportError).code).toBe('WORKSPACE_UNMAPPED');
	});

	it('drops a machine field of the wrong shape with a warning', async () => {
		const zip = writeCueBundle(path.join(tmp, 'tampered.zip'), {
			files: (files) =>
				files.set(
					'local.json',
					JSON.stringify({
						workspaces: {},
						agents: { 'agent-a': { customPath: 42, bookmarked: true } },
					})
				),
			manifest: (manifest) => {
				manifest.local = 'local.json';
			},
		});
		fs.mkdirSync(webRoot, { recursive: true });
		const plan = await planCueBundleImport(importOptions(zip, { workspaces: { proj: webRoot } }));
		expect(plan.warnings).toContain(
			'Agent "Alpha": the exact copy\'s customPath is not valid; left out.'
		);
		expect(plan.local?.agents[0].fields).toEqual(['bookmarked']);
		expect(plan.local?.agents[0].binaries).toEqual([]);
	});
});

describe('group placement', () => {
	it('puts only created agents in the group', async () => {
		seed();
		const zip = await exportLead();
		writeSessions([{ ...leadAgent(), groupId: 'old-group' }]);

		await importCueBundle(
			importOptions(zip, { workspaces: { web: webRoot }, groupId: 'new-group', force: true })
		);
		expect(storedAgent().groupId).toBe('old-group');
	});
});
