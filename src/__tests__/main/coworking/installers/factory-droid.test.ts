import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { factoryDroidInstaller } from '../../../../main/coworking/installers/factory-droid';

const SPEC = {
	command: '/abs/path/coworking-mcp-server.js',
	args: ['/abs/path/coworking-mcp-server.js'],
	env: { MAESTRO_COWORKING_SOCKET: '/tmp/maestro-coworking.sock' },
};

describe('factoryDroidInstaller', () => {
	let tmpHome: string;
	let originalHome: string | undefined;
	let originalUserProfile: string | undefined;

	beforeEach(() => {
		tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-coworking-droid-'));
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

	const cfgPath = () => path.join(tmpHome, '.factory', 'mcp.json');

	it('writes type:"stdio" with command + args + env', async () => {
		await factoryDroidInstaller.install(SPEC);
		const cfg = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
		const entry = cfg.mcpServers['maestro-coworking'];
		expect(entry.type).toBe('stdio');
		expect(entry.command).toBe(SPEC.command);
		expect(entry.args).toEqual(SPEC.args);
		expect(entry.env).toEqual(SPEC.env);
	});

	it('round-trips: uninstall removes mcpServers when empty', async () => {
		await factoryDroidInstaller.install(SPEC);
		expect(await factoryDroidInstaller.isInstalled()).toBe(true);
		await factoryDroidInstaller.uninstall();
		expect(await factoryDroidInstaller.isInstalled()).toBe(false);
		const after = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
		expect(after.mcpServers).toBeUndefined();
	});

	it('preserves unrelated mcpServers entries on uninstall', async () => {
		const seed = {
			mcpServers: {
				other: { type: 'stdio', command: 'noop', args: [], env: {} },
			},
		};
		fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
		fs.writeFileSync(cfgPath(), JSON.stringify(seed, null, 2));

		await factoryDroidInstaller.install(SPEC);
		await factoryDroidInstaller.uninstall();
		const after = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
		expect(after.mcpServers.other.type).toBe('stdio');
		expect(after.mcpServers['maestro-coworking']).toBeUndefined();
	});

	it('preserves comments and appends its owned entry after user-owned servers', async () => {
		fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
		fs.writeFileSync(
			cfgPath(),
			`// User heading
{
	/* Preserve Factory preferences. */
	"mcpServers": {
		// Existing server comment.
		"existing": { "type": "stdio", "command": "noop", "args": [] }
	}
}
`
		);

		await factoryDroidInstaller.install(SPEC);

		const written = fs.readFileSync(cfgPath(), 'utf8');
		expect(written).toContain('// User heading');
		expect(written).toContain('/* Preserve Factory preferences. */');
		expect(written).toContain('// Existing server comment.');
		expect(written.indexOf('"existing"')).toBeLessThan(written.indexOf('"maestro-coworking"'));
	});
});
