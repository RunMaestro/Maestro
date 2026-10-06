/**
 * The running app's bundle service: what the Cue modal's Bundles tab and
 * `maestro-cli bundle export|import` (through the WebSocket bridge) both call.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	exportBundleFromApp,
	importBundleIntoApp,
	inspectBundle,
	type CueBundleAppContext,
} from '../../main/cue-bundle-service';
import type { SessionInfo } from '../../shared/types';

const AGENT_ID = '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';

let tmp: string;
let root: string;

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function agent(overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		id: AGENT_ID,
		name: 'Planner',
		toolType: 'codex',
		cwd: root,
		projectRoot: root,
		...overrides,
	} as SessionInfo;
}

function context(
	sessions: SessionInfo[],
	dataDir = path.join(tmp, 'app-data')
): CueBundleAppContext {
	fs.mkdirSync(dataDir, { recursive: true });
	return {
		dataDir,
		agentConfigsDir: dataDir,
		version: '0.18.6',
		getSessions: () => sessions,
		applyAgents: vi.fn(async () => {}),
	};
}

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cue-bundle-service-')));
	root = path.join(tmp, 'work', 'planner');
	write(
		path.join(root, '.maestro/cue.yaml'),
		'subscriptions:\n  - name: hourly\n    event: time.heartbeat\n    interval_minutes: 60\n    prompt: plan\n'
	);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('exportBundleFromApp', () => {
	it('exports from the live agents, with no sessions file on disk', async () => {
		const ctx = context([agent()]);
		const outputPath = path.join(tmp, 'out', 'planner.zip');
		const outcome = await exportBundleFromApp(ctx, { agentId: AGENT_ID, outputPath });
		expect(outcome).toMatchObject({ ok: true, outputPath });
		if (!outcome.ok) return;
		expect(outcome.manifest.name).toBe('Planner');
		expect(outcome.manifest.producer.version).toBe('0.18.6');
		expect(fs.existsSync(path.join(ctx.dataDir, 'maestro-sessions.json'))).toBe(false);
	});

	it('resolves an agent by name or id prefix against the live agents', async () => {
		const ctx = context([agent()]);
		const byName = await exportBundleFromApp(ctx, {
			agent: 'planner',
			outputPath: path.join(tmp, 'a.zip'),
		});
		expect(byName).toMatchObject({ ok: true });
		const byPrefix = await exportBundleFromApp(ctx, {
			agent: AGENT_ID.slice(0, 8),
			outputPath: path.join(tmp, 'b.zip'),
		});
		expect(byPrefix).toMatchObject({ ok: true });
		expect(
			await exportBundleFromApp(ctx, { agent: 'nobody', outputPath: path.join(tmp, 'c.zip') })
		).toMatchObject({ ok: false, code: 'AGENT_NOT_FOUND' });
	});

	it('reports a refusal as data', async () => {
		const outcome = await exportBundleFromApp(context([agent()]), {
			agentId: 'missing',
			outputPath: path.join(tmp, 'x.zip'),
		});
		expect(outcome).toEqual({
			ok: false,
			code: 'EXPORT_FAILED',
			message: expect.stringContaining('Agent not found'),
		});
	});

	it('wants an absolute output path', async () => {
		const outcome = await exportBundleFromApp(context([agent()]), {
			agentId: AGENT_ID,
			outputPath: 'relative.zip',
		});
		expect(outcome).toMatchObject({ ok: false, code: 'INVALID_OPTIONS' });
	});
});

describe('inspectBundle', () => {
	it('returns the manifest, README and validation', async () => {
		const outputPath = path.join(tmp, 'planner.zip');
		await exportBundleFromApp(context([agent()]), { agentId: AGENT_ID, outputPath });
		const outcome = inspectBundle(outputPath, '0.18.6');
		expect(outcome).toMatchObject({ ok: true, valid: true, errors: [] });
		if (!outcome.ok) return;
		expect(outcome.manifest?.agents.map((a) => a.name)).toEqual(['Planner']);
		expect(outcome.readme).toContain('# Planner');
	});

	it('says why a bundle is too new for this app', async () => {
		const outputPath = path.join(tmp, 'planner.zip');
		await exportBundleFromApp(context([agent()]), { agentId: AGENT_ID, outputPath });
		const outcome = inspectBundle(outputPath, '0.1.0');
		expect(outcome).toMatchObject({ ok: true, valid: false });
		if (outcome.ok) expect(outcome.manifest?.name).toBe('Planner');
	});

	it('returns no manifest when its shape is wrong, so nothing displays a broken one', async () => {
		const archiver = (await import('archiver')).default;
		const bad = path.join(tmp, 'bad.zip');
		await new Promise<void>((resolve, reject) => {
			const out = fs.createWriteStream(bad);
			const zip = archiver('zip');
			out.on('close', () => resolve());
			zip.on('error', reject);
			zip.pipe(out);
			zip.append('{}', { name: 'manifest.json' });
			void zip.finalize();
		});
		const outcome = inspectBundle(bad, '0.18.6');
		expect(outcome).toMatchObject({ ok: true, valid: false });
		if (outcome.ok) {
			expect(outcome.manifest).toBeUndefined();
			expect(outcome.errors.length).toBeGreaterThan(0);
		}
	});

	it('reports a file that is not a zip', () => {
		const notZip = path.join(tmp, 'not.zip');
		write(notZip, 'hello');
		expect(inspectBundle(notZip, '0.18.6')).toMatchObject({
			ok: false,
			code: 'BUNDLE_UNREADABLE',
		});
	});
});

describe('importBundleIntoApp', () => {
	async function bundle(): Promise<string> {
		const outputPath = path.join(tmp, 'planner.zip');
		await exportBundleFromApp(context([agent()], path.join(tmp, 'src-data')), {
			agentId: AGENT_ID,
			outputPath,
		});
		return outputPath;
	}

	function target(): string {
		const dir = path.join(tmp, 'elsewhere', 'planner');
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	it('plans without writing or touching the app', async () => {
		const bundlePath = await bundle();
		const ctx = context([]);
		const dst = target();
		const outcome = await importBundleIntoApp(ctx, {
			bundlePath,
			workspaces: { planner: dst },
			dryRun: true,
		});
		expect(outcome).toMatchObject({ ok: true, applied: false });
		expect(ctx.applyAgents).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(dst, '.maestro/cue.yaml'))).toBe(false);
	});

	it('imports and hands the new agent to the app', async () => {
		const bundlePath = await bundle();
		const ctx = context([]);
		const dst = target();
		const outcome = await importBundleIntoApp(ctx, { bundlePath, workspaces: { planner: dst } });
		expect(outcome).toMatchObject({ ok: true, applied: true });
		expect(ctx.applyAgents).toHaveBeenCalledWith({
			created: [expect.objectContaining({ id: AGENT_ID, name: 'Planner', projectRoot: dst })],
			updated: [],
		});
		expect(fs.readFileSync(path.join(dst, '.maestro/cue.yaml'), 'utf-8')).toContain('hourly');
	});

	it('carries the conflict list in the outcome', async () => {
		const bundlePath = await bundle();
		const dst = target();
		const ctx = context([agent({ cwd: dst, projectRoot: dst })]);
		const outcome = await importBundleIntoApp(ctx, { bundlePath, workspaces: { planner: dst } });
		expect(outcome).toMatchObject({
			ok: false,
			code: 'CONFLICTS',
			details: { conflicts: expect.arrayContaining([expect.objectContaining({ kind: 'agent' })]) },
		});

		const forced = await importBundleIntoApp(ctx, {
			bundlePath,
			workspaces: { planner: dst },
			force: true,
		});
		expect(forced).toMatchObject({ ok: true, applied: true });
		expect(ctx.applyAgents).toHaveBeenLastCalledWith({
			created: [],
			updated: [expect.objectContaining({ id: AGENT_ID })],
		});
	});

	it("runs overlapping imports one after the other, so neither loses the other's MCP server", async () => {
		async function bundleWithServer(name: string, id: string, server: string): Promise<string> {
			const root = path.join(tmp, name, 'proj');
			write(
				path.join(root, '.mcp.json'),
				JSON.stringify({ mcpServers: { [server]: { command: server } } })
			);
			const outputPath = path.join(tmp, `${name}.zip`);
			const outcome = await exportBundleFromApp(
				context(
					[agent({ id, name, toolType: 'claude-code', cwd: root, projectRoot: root })],
					path.join(tmp, `${name}-data`)
				),
				{ agentId: id, outputPath }
			);
			expect(outcome.ok).toBe(true);
			return outputPath;
		}
		const first = await bundleWithServer('alpha', '1a2b3c4d-0000-4000-8000-000000000001', 'alpha');
		const second = await bundleWithServer('beta', '1a2b3c4d-0000-4000-8000-000000000002', 'beta');
		const dst = path.join(tmp, 'shared', 'proj');
		fs.mkdirSync(dst, { recursive: true });
		const ctx = context([]);

		const results = await Promise.all([
			importBundleIntoApp(ctx, { bundlePath: first, workspaces: { proj: dst } }),
			importBundleIntoApp(ctx, { bundlePath: second, workspaces: { proj: dst } }),
		]);

		expect(results.map((r) => r.ok)).toEqual([true, true]);
		const servers = JSON.parse(fs.readFileSync(path.join(dst, '.mcp.json'), 'utf-8')).mcpServers;
		expect(Object.keys(servers).sort()).toEqual(['alpha', 'beta']);
	});

	it('wants absolute paths', async () => {
		const ctx = context([]);
		expect(await importBundleIntoApp(ctx, { bundlePath: 'b.zip', workspaces: {} })).toMatchObject({
			ok: false,
			code: 'INVALID_OPTIONS',
		});
		expect(
			await importBundleIntoApp(ctx, {
				bundlePath: path.join(tmp, 'b.zip'),
				workspaces: { planner: 'relative' },
			})
		).toMatchObject({ ok: false, code: 'INVALID_OPTIONS' });
	});
});
