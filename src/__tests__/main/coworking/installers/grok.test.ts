/**
 * The Grok coworking installer over a scratch home: the selected
 * account's `config.toml` (`$GROK_HOME`, else `~/.grok`), the entry produced by
 * the one Grok MCP injection builder inside a sentinel block, truthful status,
 * user configuration preserved byte-exact, and every refusal leaving the file
 * as it was. No Grok binary is involved: PATH points at an empty directory and
 * nothing here spawns a process. Installing is not qualification (parity S35).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseToml } from 'smol-toml';
import {
	GrokCoworkingInstallRefusedError,
	grokInstaller,
} from '../../../../main/coworking/installers/grok';
import { COWORKING_SUPPORTED_AGENTS, getInstaller } from '../../../../main/coworking/installers';
import { MCP_CONFIG_BY_AGENT } from '../../../../shared/plugins/mcp-agent-config';

const SPEC = {
	command: '/abs/path/node',
	args: ['/abs/path/coworking-mcp-server.js'],
	env: { MAESTRO_COWORKING_SOCKET: '/tmp/maestro-coworking.sock' },
};

const ENV_KEYS = ['HOME', 'USERPROFILE', 'GROK_HOME', 'PATH'] as const;

describe('grokInstaller', () => {
	let tmpHome: string;
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-coworking-grok-'));
		for (const key of ENV_KEYS) saved[key] = process.env[key];
		process.env.HOME = tmpHome;
		process.env.USERPROFILE = tmpHome;
		delete process.env.GROK_HOME;
		// No Grok binary anywhere on PATH: the installer must not need one.
		const emptyBin = path.join(tmpHome, 'empty-bin');
		fs.mkdirSync(emptyBin);
		process.env.PATH = emptyBin;
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		fs.rmSync(tmpHome, { recursive: true, force: true });
	});

	const defaultConfig = () => path.join(tmpHome, '.grok', 'config.toml');
	const seed = (file: string, content: string) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	};
	const refusalOf = async (run: Promise<unknown>) => {
		const err = await run.then(
			() => null,
			(e: unknown) => e
		);
		expect(err).toBeInstanceOf(GrokCoworkingInstallRefusedError);
		return (err as GrokCoworkingInstallRefusedError).refusal;
	};

	describe('configured profile', () => {
		it('is registered for the Settings rows and the dispatcher', () => {
			expect(COWORKING_SUPPORTED_AGENTS).toContain('grok');
			expect(getInstaller('grok')).toBe(grokInstaller);
		});

		it('targets ~/.grok/config.toml when GROK_HOME is unset or blank', () => {
			expect(grokInstaller.configPath()).toBe(defaultConfig());
			process.env.GROK_HOME = '   ';
			expect(grokInstaller.configPath()).toBe(defaultConfig());
		});

		it('targets the selected GROK_HOME account and leaves ~/.grok alone', async () => {
			const account = path.join(tmpHome, 'accounts', 'work');
			process.env.GROK_HOME = account;
			expect(grokInstaller.configPath()).toBe(path.join(account, 'config.toml'));
			await grokInstaller.install(SPEC);
			expect(await grokInstaller.isInstalled()).toBe(true);
			expect(fs.existsSync(path.join(account, 'config.toml'))).toBe(true);
			expect(fs.existsSync(path.join(tmpHome, '.grok'))).toBe(false);
			// Another account reads its own file: not installed there.
			process.env.GROK_HOME = path.join(tmpHome, 'accounts', 'home');
			expect(await grokInstaller.isInstalled()).toBe(false);
		});
	});

	describe('install, status and uninstall', () => {
		it('round-trips byte-exactly on an absent file, with no Grok binary on PATH', async () => {
			expect(await grokInstaller.isInstalled()).toBe(false);
			await grokInstaller.install(SPEC);
			expect(await grokInstaller.isInstalled()).toBe(true);
			await grokInstaller.uninstall();
			expect(await grokInstaller.isInstalled()).toBe(false);
			expect(fs.readFileSync(defaultConfig(), 'utf8')).toBe('');
		});

		it('writes the pinned-schema entry from the Grok injection builder, renamed to maestro-coworking', async () => {
			expect(MCP_CONFIG_BY_AGENT.grok?.strategy).toBe('grok-config-overlay');
			await grokInstaller.install(SPEC);
			const content = fs.readFileSync(defaultConfig(), 'utf8');
			expect(content).toMatch(/^# >>> maestro-coworking BEGIN/);
			expect(content).toContain('# <<< maestro-coworking END');
			expect(content).not.toMatch(/\[mcp_servers\.maestro\]/);
			const parsed = parseToml(content) as { mcp_servers: Record<string, Record<string, unknown>> };
			expect(Object.keys(parsed.mcp_servers)).toEqual(['maestro-coworking']);
			const server = parsed.mcp_servers['maestro-coworking'];
			expect(server.command).toBe(SPEC.command);
			expect(server.args).toEqual(SPEC.args);
			expect(server.env).toEqual(SPEC.env);
		});

		it('is idempotent: a second install keeps one block', async () => {
			await grokInstaller.install(SPEC);
			const once = fs.readFileSync(defaultConfig(), 'utf8');
			await grokInstaller.install(SPEC);
			const twice = fs.readFileSync(defaultConfig(), 'utf8');
			expect(twice).toBe(once);
			expect(twice.match(/maestro-coworking BEGIN/g)).toHaveLength(1);
		});

		it('status is false for a marker whose table Grok would not read', async () => {
			seed(
				defaultConfig(),
				'# >>> maestro-coworking BEGIN - managed by Maestro, do not edit\n# <<< maestro-coworking END\n'
			);
			expect(await grokInstaller.isInstalled()).toBe(false);
		});

		it('uninstall with no file or no block is a no-op', async () => {
			await grokInstaller.uninstall();
			expect(fs.existsSync(defaultConfig())).toBe(false);
			const user = 'model = "grok-4.5"\n';
			seed(defaultConfig(), user);
			await grokInstaller.uninstall();
			expect(fs.readFileSync(defaultConfig(), 'utf8')).toBe(user);
		});
	});

	describe('unrelated configuration', () => {
		const USER = `# user comments stay
model = "grok-4.5"

[mcp_servers.user-server]
command = "noop"
args = []

[ui]
theme = "dark"
`;

		it('install keeps user tables and comments, uninstall restores the file byte-exact', async () => {
			seed(defaultConfig(), USER);
			await grokInstaller.install(SPEC);
			const installed = fs.readFileSync(defaultConfig(), 'utf8');
			expect(installed.startsWith(USER)).toBe(true);
			const parsed = parseToml(installed) as Record<string, any>;
			expect(parsed.model).toBe('grok-4.5');
			expect(parsed.ui).toEqual({ theme: 'dark' });
			expect(Object.keys(parsed.mcp_servers).sort()).toEqual(['maestro-coworking', 'user-server']);
			await grokInstaller.uninstall();
			expect(fs.readFileSync(defaultConfig(), 'utf8')).toBe(USER);
		});

		it('a reinstall replaces only the block and keeps user edits made around it', async () => {
			seed(defaultConfig(), USER);
			await grokInstaller.install(SPEC);
			const withEdit = `${fs.readFileSync(defaultConfig(), 'utf8')}\n[extra]\nkept = true\n`;
			fs.writeFileSync(defaultConfig(), withEdit);
			await grokInstaller.install({
				...SPEC,
				env: { MAESTRO_COWORKING_SOCKET: '/tmp/other.sock' },
			});
			const after = fs.readFileSync(defaultConfig(), 'utf8');
			expect(after).toContain('[extra]\nkept = true');
			expect(after).toContain('/tmp/other.sock');
			expect(after).not.toContain('/tmp/maestro-coworking.sock');
		});

		it('uninstall never removes a maestro-coworking server the user owns', async () => {
			const own = '[mcp_servers.maestro-coworking]\ncommand = "mine"\n';
			seed(defaultConfig(), own);
			await grokInstaller.uninstall();
			expect(fs.readFileSync(defaultConfig(), 'utf8')).toBe(own);
			// No block: the user's own entry does not count as Maestro's install.
			expect(await grokInstaller.isInstalled()).toBe(false);
		});
	});

	describe('corrupt or unsupported schema', () => {
		it('refuses config-unreadable on a file that is not TOML and leaves it unchanged', async () => {
			const bad = 'model = = "broken"\n[[[\n';
			seed(defaultConfig(), bad);
			expect(await refusalOf(grokInstaller.install(SPEC))).toBe('config-unreadable');
			expect(fs.readFileSync(defaultConfig(), 'utf8')).toBe(bad);
		});

		it('refuses config-unreadable when mcp_servers is not a table', async () => {
			const bad = 'mcp_servers = "nope"\n';
			seed(defaultConfig(), bad);
			expect(await refusalOf(grokInstaller.install(SPEC))).toBe('config-unreadable');
			expect(fs.readFileSync(defaultConfig(), 'utf8')).toBe(bad);
		});

		it('refuses schema-conflict on an inline mcp_servers table it cannot extend', async () => {
			const inline = 'mcp_servers = { user-server = { command = "noop" } }\n';
			seed(defaultConfig(), inline);
			expect(await refusalOf(grokInstaller.install(SPEC))).toBe('schema-conflict');
			expect(fs.readFileSync(defaultConfig(), 'utf8')).toBe(inline);
		});

		it('refuses entry-not-owned on a user-defined maestro-coworking server', async () => {
			const own = 'model = "x"\n\n[mcp_servers.maestro-coworking]\ncommand = "mine"\n';
			seed(defaultConfig(), own);
			expect(await refusalOf(grokInstaller.install(SPEC))).toBe('entry-not-owned');
			expect(fs.readFileSync(defaultConfig(), 'utf8')).toBe(own);
		});

		it('refuses target-unsupported on a directory and on a symbolic link', async () => {
			fs.mkdirSync(defaultConfig(), { recursive: true });
			expect(await refusalOf(grokInstaller.install(SPEC))).toBe('target-unsupported');
			expect(fs.statSync(defaultConfig()).isDirectory()).toBe(true);
			fs.rmSync(defaultConfig(), { recursive: true });

			const real = path.join(tmpHome, 'real.toml');
			fs.writeFileSync(real, 'model = "x"\n');
			let linked = true;
			try {
				fs.symlinkSync(real, defaultConfig());
			} catch {
				linked = false; // symlinks need privileges on some Windows hosts
			}
			if (linked) {
				expect(await refusalOf(grokInstaller.install(SPEC))).toBe('target-unsupported');
				expect(fs.lstatSync(defaultConfig()).isSymbolicLink()).toBe(true);
				expect(fs.readFileSync(real, 'utf8')).toBe('model = "x"\n');
			}
		});

		it('status throws on an unparseable file that carries the block instead of claiming installed', async () => {
			await grokInstaller.install(SPEC);
			fs.appendFileSync(defaultConfig(), '[[[ broken\n');
			await expect(grokInstaller.isInstalled()).rejects.toBeInstanceOf(
				GrokCoworkingInstallRefusedError
			);
		});
	});
});
