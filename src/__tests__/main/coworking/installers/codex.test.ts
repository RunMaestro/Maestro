import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { codexInstaller } from '../../../../main/coworking/installers/codex';

const SPEC = {
	command: '/abs/path/coworking-mcp-server.js',
	args: ['/abs/path/coworking-mcp-server.js'],
	env: { MAESTRO_COWORKING_SOCKET: '/tmp/maestro-coworking.sock' },
};

describe('codexInstaller', () => {
	let tmpHome: string;
	let originalHome: string | undefined;
	let originalUserProfile: string | undefined;

	beforeEach(() => {
		tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-coworking-codex-'));
		originalHome = process.env.HOME;
		originalUserProfile = process.env.USERPROFILE;
		process.env.HOME = tmpHome;
		process.env.USERPROFILE = tmpHome;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		fs.rmSync(tmpHome, { recursive: true, force: true });
	});

	const cfgPath = () => path.join(tmpHome, '.codex', 'config.toml');

	it('install + uninstall round-trips byte-exactly when there is no existing file', async () => {
		expect(await codexInstaller.isInstalled()).toBe(false);
		await codexInstaller.install(SPEC);
		expect(await codexInstaller.isInstalled()).toBe(true);
		await codexInstaller.uninstall();
		expect(await codexInstaller.isInstalled()).toBe(false);
		const after = fs.readFileSync(cfgPath(), 'utf8');
		expect(after).toBe('');
	});

	it('install preserves user content, uninstall restores it byte-exact', async () => {
		const userContent = `# user comments stay
[mcp_servers.user-server]
command = "noop"
args = []

[features]
auto_save = true
`;
		fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
		fs.writeFileSync(cfgPath(), userContent);

		await codexInstaller.install(SPEC);
		const installed = fs.readFileSync(cfgPath(), 'utf8');
		expect(installed).toContain(userContent.trimEnd());
		expect(installed).toContain('# >>> maestro-coworking BEGIN');
		expect(installed).toContain('[mcp_servers.maestro-coworking]');
		expect(installed).toContain('# <<< maestro-coworking END');

		await codexInstaller.uninstall();
		const restored = fs.readFileSync(cfgPath(), 'utf8');
		expect(restored).toBe(userContent);
	});

	it('install is idempotent - re-installing does not duplicate the block', async () => {
		await codexInstaller.install(SPEC);
		await codexInstaller.install(SPEC);
		const content = fs.readFileSync(cfgPath(), 'utf8');
		const begins = content.match(/maestro-coworking BEGIN/g) ?? [];
		const ends = content.match(/maestro-coworking END/g) ?? [];
		expect(begins.length).toBe(1);
		expect(ends.length).toBe(1);
	});

	it('emitted block is valid TOML structure (sentinel-delimited)', async () => {
		await codexInstaller.install(SPEC);
		const content = fs.readFileSync(cfgPath(), 'utf8');
		expect(content).toMatch(/\[mcp_servers\.maestro-coworking\]/);
		expect(content).toMatch(/command = ".*coworking-mcp-server\.js"/);
		expect(content).toMatch(/args = \[".*"\]/);
		expect(content).toMatch(/MAESTRO_COWORKING_SOCKET/);
	});

	it('uninstall on a non-installed config is a no-op', async () => {
		await codexInstaller.uninstall();
		expect(fs.existsSync(cfgPath())).toBe(false);
	});
});
