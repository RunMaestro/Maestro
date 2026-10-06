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
