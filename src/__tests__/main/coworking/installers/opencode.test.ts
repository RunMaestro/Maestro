import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { opencodeInstaller } from '../../../../main/coworking/installers/opencode';

const SPEC = {
	command: '/abs/path/coworking-mcp-server.js',
	args: ['/abs/path/coworking-mcp-server.js'],
	env: { MAESTRO_COWORKING_SOCKET: '/tmp/maestro-coworking.sock' },
};

describe('opencodeInstaller', () => {
	let tmpHome: string;
	let originalHome: string | undefined;
	let originalUserProfile: string | undefined;
	let originalXdg: string | undefined;

	beforeEach(() => {
		tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-coworking-opencode-'));
		originalHome = process.env.HOME;
		originalUserProfile = process.env.USERPROFILE;
		originalXdg = process.env.XDG_CONFIG_HOME;
		process.env.HOME = tmpHome;
		process.env.USERPROFILE = tmpHome;
		delete process.env.XDG_CONFIG_HOME;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		if (originalXdg !== undefined) process.env.XDG_CONFIG_HOME = originalXdg;
		else delete process.env.XDG_CONFIG_HOME;
		fs.rmSync(tmpHome, { recursive: true, force: true });
	});

	const cfgPath = () => path.join(tmpHome, '.config', 'opencode', 'opencode.json');

	it('writes type:"local" with command-as-array and environment object', async () => {
		await opencodeInstaller.install(SPEC);
		const cfg = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
		const entry = cfg.mcp['maestro-coworking'];
		expect(entry.type).toBe('local');
		expect(entry.command).toEqual([SPEC.command, ...SPEC.args]);
		expect(entry.environment).toEqual(SPEC.env);
		expect(entry.enabled).toBe(true);
	});

	it('round-trips: uninstall removes mcp key when empty', async () => {
		await opencodeInstaller.install(SPEC);
		expect(await opencodeInstaller.isInstalled()).toBe(true);
		await opencodeInstaller.uninstall();
		expect(await opencodeInstaller.isInstalled()).toBe(false);
		const after = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
		expect(after.mcp).toBeUndefined();
	});

	it('preserves unrelated mcp entries on uninstall', async () => {
		const seed = {
			theme: 'tokyo-night',
			mcp: {
				other: { type: 'local', command: ['noop'], environment: {}, enabled: true },
			},
		};
		fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
		fs.writeFileSync(cfgPath(), JSON.stringify(seed, null, 2));

		await opencodeInstaller.install(SPEC);
		await opencodeInstaller.uninstall();
		const after = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
		expect(after.theme).toBe('tokyo-night');
		expect(after.mcp.other.type).toBe('local');
		expect(after.mcp['maestro-coworking']).toBeUndefined();
	});

	it('honors XDG_CONFIG_HOME when set', async () => {
		const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'xdg-'));
		process.env.XDG_CONFIG_HOME = xdg;
		try {
			expect(opencodeInstaller.configPath()).toBe(path.join(xdg, 'opencode', 'opencode.json'));
		} finally {
			fs.rmSync(xdg, { recursive: true, force: true });
		}
	});
});
