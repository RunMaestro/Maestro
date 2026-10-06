/**
 * Claude Code assets through a real export and import, and an import into a
 * running desktop app (the host mode).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exportCueBundle } from '../../../../main/cue/bundle/cue-bundle-exporter';
import {
	importCueBundle,
	CueBundleImportError,
	type CueBundleImportHost,
} from '../../../../main/cue/bundle/cue-bundle-importer';
import { claudeMemoryDir } from '../../../../main/memory-manager';
import { readZipArchive } from '../../../../main/utils/zip-archive';
import type { CueBundleManifest } from '../../../../shared/cue-bundle-types';
import type { SessionInfo } from '../../../../shared/types';

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
	write(path.join(root, '.claude/skills/triage/SKILL.md'), '---\nname: triage\n---\nTriage it.\n');
	write(
		path.join(root, '.mcp.json'),
		JSON.stringify({
			mcpServers: { github: { command: 'gh-mcp', env: { GITHUB_TOKEN: GITHUB_PAT } } },
		})
	);
	write(path.join(root, 'CLAUDE.md'), '# App\nBuild with npm.\n');
	write(path.join(claudeMemoryDir(claudeDir, root), 'MEMORY.md'), '- deploys go out on Fridays\n');
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
		write(path.join(claudeMemoryDir(workAccount, src.root), 'MEMORY.md'), '- work account notes\n');
		const sessions = JSON.parse(
			fs.readFileSync(path.join(src.dataDir, 'maestro-sessions.json'), 'utf-8')
		);
		sessions.sessions[0].customEnvVars = { CLAUDE_CONFIG_DIR: workAccount };
		write(path.join(src.dataDir, 'maestro-sessions.json'), JSON.stringify(sessions));

		const { outputPath } = await exportAgent();
		expect(entriesOf(outputPath).get('claude-memory/app/MEMORY.md')).toBe('- work account notes\n');
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
		const memory = path.join(claudeMemoryDir(dst.claudeDir, dst.root), 'MEMORY.md');
		expect(fs.readFileSync(memory, 'utf-8')).toBe('- deploys go out on Fridays\n');
		expect(plan.files.find((f) => f.kind === 'claude-memory')?.target).toBe(memory);
		expect(plan.secrets.find((s) => s.name === 'GITHUB_TOKEN')).toMatchObject({
			set: false,
			usedBy: ['mcp:app'],
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
			expect(fs.statSync(path.join(dst.root, '.claude/skills/triage/SKILL.md')).mode & 0o111).toBe(
				0
			);
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
