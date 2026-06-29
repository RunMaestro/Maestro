import { describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	buildOmpArgs,
	discoveryPathFor,
	mapPathFor,
	resolveOmpBin,
	resolveResume,
	runMae,
} from '../launcher';
import { upsertRecord } from '../session-map';

describe('buildOmpArgs', () => {
	test('composes profile + extension + prompt + config + resume + passthrough', () => {
		const args = buildOmpArgs({
			profile: 'maestro',
			extensionPath: '/x/ext.mjs',
			appendSystemPrompt: 'hi',
			configOverlayPath: '/x/c.yml',
			resumeOmpSessionId: '/s/a.jsonl',
			passthrough: ['hello'],
		});
		expect(args.slice(0, 4)).toEqual(['--profile', 'maestro', '-e', '/x/ext.mjs']);
		expect(args).toContain('--append-system-prompt');
		expect(args).toContain('--config');
		expect(args).toContain('--resume');
		expect(args[args.indexOf('--resume') + 1]).toBe('/s/a.jsonl');
		expect(args[args.length - 1]).toBe('hello');
	});

	test('omits empty prompt, missing config and resume', () => {
		const args = buildOmpArgs({
			profile: 'maestro',
			extensionPath: '/x/ext.mjs',
			appendSystemPrompt: '   ',
			passthrough: [],
		});
		expect(args).not.toContain('--append-system-prompt');
		expect(args).not.toContain('--config');
		expect(args).not.toContain('--resume');
	});
});

describe('resolveOmpBin + mapPathFor', () => {
	test('resolveOmpBin honors MAE_OMP_BIN override', () => {
		expect(resolveOmpBin({ MAE_OMP_BIN: '/custom/omp' })).toBe('/custom/omp');
	});

	test('mapPathFor uses override then a profile default', () => {
		expect(mapPathFor({ MAE_MAP_PATH: '/tmp/m.json' })).toBe('/tmp/m.json');
		const def = mapPathFor({ USERPROFILE: '/home/u' }).replace(/\\/g, '/');
		expect(def).toContain('/.omp/profiles/maestro/agent/mae/session-map.json');
	});
});

describe('resolveResume', () => {
	test("returns passthrough when the first arg is not 'resume'", async () => {
		const r = await resolveResume(['hello', 'world'], {});
		expect(r.passthrough).toEqual(['hello', 'world']);
		expect(r.resumeOmpSessionId).toBeUndefined();
	});

	test('resolves an omp resume key from the identity map', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mae-res-'));
		const map = path.join(dir, 'map.json');
		await upsertRecord(map, {
			maestroSessionId: 'm1',
			ompSessionId: '/s/a.jsonl',
			engine: 'omp',
			cwd: '/repo',
			title: 'Build mae',
			runId: 'r',
			startedAt: 1,
			lastActiveAt: 2,
		});
		const r = await resolveResume(['resume', 'Build'], { MAE_MAP_PATH: map });
		expect(r.resumeOmpSessionId).toBe('/s/a.jsonl');
		expect(r.maestroSessionId).toBe('m1');
		expect(r.error).toBeUndefined();
	});

	test('errors when nothing matches', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mae-res-'));
		const r = await resolveResume(['resume', 'nope'], { MAE_MAP_PATH: path.join(dir, 'map.json') });
		expect(r.error).toBeDefined();
	});
});

describe('runMae --mae-dry-run', () => {
	test('prints the resolved plan and does not spawn', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mae-run-'));
		let printed = '';
		const code = await runMae({
			argv: ['--mae-dry-run', 'hello'],
			env: {
				USERPROFILE: dir,
				MAE_OMP_BIN: '/bin/omp',
				MAE_MAP_PATH: path.join(dir, 'map.json'),
				MAE_BRIDGE_DISCOVERY: path.join(dir, 'no-such-discovery.json'),
			},
			moduleDir: dir,
			stdout: (text) => {
				printed += text;
			},
		});
		expect(code).toBe(0);
		const plan: unknown = JSON.parse(printed);
		expect(plan && typeof plan === 'object' && 'ompBin' in plan ? plan.ompBin : '').toBe(
			'/bin/omp'
		);
		expect(
			plan && typeof plan === 'object' && 'bridgeConnected' in plan ? plan.bridgeConnected : true
		).toBe(false);
	});
});

describe('discoveryPathFor', () => {
	test('honors the MAE_BRIDGE_DISCOVERY override', () => {
		expect(discoveryPathFor({ MAE_BRIDGE_DISCOVERY: '/x/disc.json' })).toBe('/x/disc.json');
	});

	test('uses MAESTRO_USER_DATA when set (matches Maestro shared config dir)', () => {
		const p = discoveryPathFor({ MAESTRO_USER_DATA: '/data/maestro' }).replace(/\\/g, '/');
		expect(p.endsWith('data/maestro/mae-bridge.json')).toBe(true);
	});

	test('falls back to the platform maestro config dir (lowercase maestro)', () => {
		const p = discoveryPathFor({ USERPROFILE: '/home/u', HOME: '/home/u' }).replace(/\\/g, '/');
		expect(p.endsWith('/maestro/mae-bridge.json')).toBe(true);
	});
});
