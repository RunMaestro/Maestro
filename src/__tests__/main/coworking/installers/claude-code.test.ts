import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeCodeInstaller } from '../../../../main/coworking/installers/claude-code';

const SPEC = {
	command: '/abs/path/coworking-mcp-server.js',
	args: ['/abs/path/coworking-mcp-server.js'],
	env: { MAESTRO_COWORKING_SOCKET: '/tmp/maestro-coworking.sock' },
};

describe('claudeCodeInstaller', () => {
	let tmpHome: string;
	let originalHome: string | undefined;
	let originalUserProfile: string | undefined;

	beforeEach(() => {
		tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-coworking-claude-'));
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

	const cfgPath = () => path.join(tmpHome, '.claude.json');

	it('reports not installed when the file does not exist', async () => {
		expect(await claudeCodeInstaller.isInstalled()).toBe(false);
	});

	it('install creates the file with the entry; uninstall removes it cleanly', async () => {
		await claudeCodeInstaller.install(SPEC);
		expect(await claudeCodeInstaller.isInstalled()).toBe(true);
		const cfg = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
		expect(cfg.mcpServers['maestro-coworking']).toEqual({
			command: SPEC.command,
			args: SPEC.args,
			env: SPEC.env,
		});

		await claudeCodeInstaller.uninstall();
		expect(await claudeCodeInstaller.isInstalled()).toBe(false);
		const after = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
		expect(after.mcpServers).toBeUndefined();
	});

	it('install preserves unrelated user content', async () => {
		const seed = {
			theme: 'dark',
			mcpServers: {
				existing: { command: 'noop', args: [], env: {} },
			},
			otherKey: { nested: true },
		};
		fs.writeFileSync(cfgPath(), JSON.stringify(seed, null, 2));
		await claudeCodeInstaller.install(SPEC);

		const cfg = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
		expect(cfg.theme).toBe('dark');
		expect(cfg.otherKey).toEqual({ nested: true });
		expect(cfg.mcpServers.existing).toEqual({ command: 'noop', args: [], env: {} });
		expect(cfg.mcpServers['maestro-coworking']).toBeDefined();

		await claudeCodeInstaller.uninstall();
		const after = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
		expect(after.mcpServers).toEqual({ existing: { command: 'noop', args: [], env: {} } });
		expect(after.theme).toBe('dark');
	});

	it('install is idempotent', async () => {
		await claudeCodeInstaller.install(SPEC);
		await claudeCodeInstaller.install(SPEC);
		expect(await claudeCodeInstaller.isInstalled()).toBe(true);
		const cfg = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
		expect(Object.keys(cfg.mcpServers)).toEqual(['maestro-coworking']);
	});

	it('uninstall on a non-installed config is a no-op', async () => {
		await claudeCodeInstaller.uninstall();
		expect(fs.existsSync(cfgPath())).toBe(false);
	});
});
