// Source: src/__tests__/main/coworking/installers/claude-code.test.ts
// Source: src/__tests__/main/coworking/installers/factory-droid.test.ts
// Source: src/__tests__/main/coworking/installers/opencode.test.ts
// Source: src/__tests__/main/coworking/installers/grok.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeCodeInstaller } from '../../../../main/coworking/installers/claude-code';
import { factoryDroidInstaller } from '../../../../main/coworking/installers/factory-droid';
import { opencodeInstaller } from '../../../../main/coworking/installers/opencode';
import { parse as parseToml } from 'smol-toml';
import { GrokCoworkingInstallRefusedError } from '../../../../main/coworking/installers/grok';
import { grokInstaller } from '../../../../main/coworking/installers/grok';
import { COWORKING_SUPPORTED_AGENTS } from '../../../../main/coworking/installers';
import { getInstaller } from '../../../../main/coworking/installers';
import { MCP_CONFIG_BY_AGENT } from '../../../../shared/plugins/mcp-agent-config';
describeSourceSuite('claude-code', () => {
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
});
describeSourceSuite('factory-droid', () => {
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
	});
});
describeSourceSuite('opencode', () => {
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
});
describeSourceSuite('grok', () => {
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
				const parsed = parseToml(content) as {
					mcp_servers: Record<string, Record<string, unknown>>;
				};
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
				expect(Object.keys(parsed.mcp_servers).sort()).toEqual([
					'maestro-coworking',
					'user-server',
				]);
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
});
