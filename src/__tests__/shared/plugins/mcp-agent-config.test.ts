/**
 * @file Unit tests for the per-agent ephemeral MCP-config adapters: each strategy
 * produces the right globalArgs / env / temp files, and the agent map marks the
 * installed CLIs verified and the rest best-guess.
 */
import { describe, it, expect } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import {
	buildMcpInjection,
	classifyGrokMcpServer,
	GROK_COMPAT_RESOURCES,
	GROK_COMPAT_VENDORS,
	grokCompatScannerEnvName,
	grokNativeTrustProblem,
	mcpInjectionProblem,
	mergeMcpInjectionArgs,
	MCP_CONFIG_BY_AGENT,
	MCP_SERVER_NAME,
	readGrokNativeTrust,
	type GrokMcpServerObservation,
	type McpConfigCapability,
	type McpServerSpec,
} from '../../../shared/plugins/mcp-agent-config';
import { grokAcpConfigGeneration } from '../../../shared/maestro-lib/grok/route';

const spec: McpServerSpec = {
	command: '/bin/electron',
	args: ['/cli.js', 'mcp', 'serve', '--tab', 't1'],
	env: { ELECTRON_RUN_AS_NODE: '1' },
};
const opts = { tmpDir: '/tmp', join: (...p: string[]) => p.join('/') };

describe('buildMcpInjection - claude-mcp-config', () => {
	it('emits inline --mcp-config JSON (additive, no --strict, no temp files)', () => {
		const inj = buildMcpInjection({ strategy: 'claude-mcp-config', verified: true }, spec, opts);
		expect(inj.files).toEqual([]);
		expect(inj.env).toEqual({});
		expect(inj.globalArgs[0]).toBe('--mcp-config');
		expect(inj.globalArgs).toHaveLength(2);
		expect(JSON.parse(inj.globalArgs[1])).toEqual({
			mcpServers: { [MCP_SERVER_NAME]: { command: spec.command, args: spec.args, env: spec.env } },
		});
	});
});

describe('buildMcpInjection - codex-config-override', () => {
	it('emits -c mcp_servers overrides with TOML-encoded values, no files', () => {
		const inj = buildMcpInjection(
			{ strategy: 'codex-config-override', verified: true },
			spec,
			opts
		);
		expect(inj.files).toEqual([]);
		expect(inj.env).toEqual({});
		expect(inj.globalArgs).toContain(
			`mcp_servers.${MCP_SERVER_NAME}.command=${JSON.stringify(spec.command)}`
		);
		expect(inj.globalArgs).toContain(
			`mcp_servers.${MCP_SERVER_NAME}.args=["/cli.js", "mcp", "serve", "--tab", "t1"]`
		);
		expect(inj.globalArgs.some((a) => a.startsWith(`mcp_servers.${MCP_SERVER_NAME}.env=`))).toBe(
			true
		);
	});

	it('omits the env override when the spec carries no env', () => {
		const inj = buildMcpInjection(
			{ strategy: 'codex-config-override', verified: true },
			{ command: 'codex', args: [] },
			opts
		);
		expect(inj.globalArgs.some((a) => a.includes('.env='))).toBe(false);
	});
});

describe('buildMcpInjection - opencode-env-config', () => {
	it('writes a temp opencode.json and points OPENCODE_CONFIG at it', () => {
		const inj = buildMcpInjection(
			{
				strategy: 'opencode-env-config',
				verified: true,
				envVar: 'OPENCODE_CONFIG',
				fileName: 'oc.json',
			},
			spec,
			opts
		);
		expect(inj.globalArgs).toEqual([]);
		expect(inj.env).toEqual({ OPENCODE_CONFIG: '/tmp/oc.json' });
		expect(inj.files).toHaveLength(1);
		expect(inj.files[0].path).toBe('/tmp/oc.json');
		const cfg = JSON.parse(inj.files[0].content);
		expect(cfg.mcp[MCP_SERVER_NAME]).toMatchObject({
			type: 'local',
			command: [spec.command, ...spec.args],
			environment: spec.env,
			enabled: true,
		});
	});
});

describe('buildMcpInjection - mcp-json-file', () => {
	it('writes a { mcpServers } file and sets env when an envVar is given', () => {
		const inj = buildMcpInjection(
			{ strategy: 'mcp-json-file', verified: false, envVar: 'X_CFG', fileName: 'x.json' },
			spec,
			opts
		);
		expect(inj.env).toEqual({ X_CFG: '/tmp/x.json' });
		expect(JSON.parse(inj.files[0].content)).toEqual({
			mcpServers: { [MCP_SERVER_NAME]: { command: spec.command, args: spec.args, env: spec.env } },
		});
	});

	it('writes the file but sets no env when no envVar is given', () => {
		const inj = buildMcpInjection(
			{ strategy: 'mcp-json-file', verified: false, fileName: 'x.json' },
			spec,
			opts
		);
		expect(inj.env).toEqual({});
		expect(inj.files).toHaveLength(1);
	});
});

describe('MCP_CONFIG_BY_AGENT', () => {
	it('marks the auto-injected installed CLIs (claude, codex) verified', () => {
		expect(MCP_CONFIG_BY_AGENT['claude-code'].verified).toBe(true);
		expect(MCP_CONFIG_BY_AGENT.codex.verified).toBe(true);
	});

	it('marks the other agents as best-guess (unverified)', () => {
		for (const id of [
			'opencode',
			'gemini-cli',
			'qwen3-coder',
			'copilot-cli',
			'factory-droid',
			'hermes',
			'pi',
		]) {
			expect(MCP_CONFIG_BY_AGENT[id].verified).toBe(false);
		}
	});
});

describe('mergeMcpInjectionArgs', () => {
	const injectionArgs = ['-c', 'mcp_servers.maestro.command="/bin/electron"'];

	it.each([
		['-C', '/project', 'exec', '-c', 'model_reasoning_summary=auto'],
		['-C', '/project', 'exec', 'resume', 'provider-id', '-c', 'model_reasoning_summary=auto'],
	])('keeps Codex MCP overrides in the same scope as agent config: %j', (...agentArgs) => {
		expect(mergeMcpInjectionArgs(MCP_CONFIG_BY_AGENT.codex, agentArgs, injectionArgs)).toEqual([
			...agentArgs,
			...injectionArgs,
		]);
	});

	it('inserts Codex config before a positional prompt, preserving prompt contents', () => {
		const args = ['exec', 'resume', 'provider-id', '-c', 'model_reasoning_summary=auto'];
		const prompt = '-c mcp_servers.maestro.command="untrusted prompt content"';
		expect(
			mergeMcpInjectionArgs(MCP_CONFIG_BY_AGENT.codex, [...args, '--', prompt], injectionArgs)
		).toEqual([...args, ...injectionArgs, '--', prompt]);
	});

	it('preserves global placement for Claude', () => {
		const args = ['--print', '--', 'prompt'];
		const config = ['--mcp-config', '{"mcpServers":{}}'];
		expect(mergeMcpInjectionArgs(MCP_CONFIG_BY_AGENT['claude-code'], args, config)).toEqual([
			...config,
			...args,
		]);
	});
});

// The Grok overlay. The account's own config.toml is never named,
// read or written; the injection is one owned file under the caller's temp root.
describe('Grok MCP configuration overlay', () => {
	const production = MCP_CONFIG_BY_AGENT.grok;
	/** The production entry with a qualified binary, as Phase 11 would list it. */
	const qualified: McpConfigCapability = {
		...production,
		verified: true,
		qualifiedVersions: ['0.1.200'],
	};
	const ownedRoot = '/tmp/maestro-mcp-profile-a';
	const at = (tmpDir: string) => ({ tmpDir, join: (...p: string[]) => p.join('/') });
	/** The bridge carries the run proof as a file path, never the token itself. */
	const bridge: McpServerSpec = {
		command: '/Applications/Maestro.app/Contents/MacOS/Maestro',
		args: ['/cli.js', 'mcp', 'serve', '--tab', 't1'],
		env: {
			ELECTRON_RUN_AS_NODE: '1',
			MAESTRO_PLUGIN_RUN_TOKEN_FILE: '/tmp/maestro-plugin-run-x/proof',
		},
	};

	describe('buildMcpInjection - grok-config-overlay', () => {
		it('writes one owned config.toml under the given root and points GROK_CONFIG_PATH at it', () => {
			const inj = buildMcpInjection(production, bridge, at(ownedRoot));
			expect(inj.globalArgs).toEqual([]);
			expect(inj.env).toEqual({ GROK_CONFIG_PATH: `${ownedRoot}/config.toml` });
			expect(inj.files).toEqual([
				{ path: `${ownedRoot}/config.toml`, content: expect.any(String) },
			]);
			expect(inj.files[0].content.endsWith('\n')).toBe(true);
		});

		it('holds the Maestro bridge table and nothing else, so account settings and servers merge untouched', () => {
			const cfg = parseToml(buildMcpInjection(production, bridge, at(ownedRoot)).files[0].content);
			expect(cfg).toEqual({
				mcp_servers: {
					[MCP_SERVER_NAME]: {
						command: bridge.command,
						args: bridge.args,
						env: bridge.env,
						enabled: true,
					},
				},
			});
		});

		it('omits the env table when the bridge carries no environment', () => {
			const cfg = parseToml(
				buildMcpInjection(production, { command: 'node', args: [] }, at(ownedRoot)).files[0].content
			) as { mcp_servers: Record<string, Record<string, unknown>> };
			expect(cfg.mcp_servers[MCP_SERVER_NAME]).toEqual({
				command: 'node',
				args: [],
				enabled: true,
			});
		});

		it('keeps hostile names and values inside their strings: no extra server, table or key', () => {
			const hostile: McpServerSpec = {
				command: '/bin/x"\n[mcp_servers.evil]\ncommand = "/bin/sh',
				args: ['--tab', '"]\n[mcp_servers.other]\nenabled = true\n#', "it's\\ok"],
				env: {
					'KEY = "x"\n[mcp_servers.injected]': 'v"\nenabled = false',
					PLAIN: 'line\r\nbreak\ttab',
				},
			};
			const cfg = parseToml(
				buildMcpInjection(production, hostile, at(ownedRoot)).files[0].content
			) as {
				mcp_servers: Record<string, Record<string, unknown>>;
			};
			expect(Object.keys(cfg)).toEqual(['mcp_servers']);
			expect(Object.keys(cfg.mcp_servers)).toEqual([MCP_SERVER_NAME]);
			expect(cfg.mcp_servers[MCP_SERVER_NAME]).toEqual({
				command: hostile.command,
				args: hostile.args,
				env: hostile.env,
				enabled: true,
			});
		});

		it('gives each profile root its own file and never addresses the account config', () => {
			const a = buildMcpInjection(production, bridge, at('/tmp/maestro-mcp-profile-a'));
			const b = buildMcpInjection(production, bridge, at('/tmp/maestro-mcp-profile-b'));
			expect(a.files[0].path).not.toBe(b.files[0].path);
			for (const inj of [a, b]) {
				const target = inj.env.GROK_CONFIG_PATH;
				expect(inj.files.map((f) => f.path)).toEqual([target]);
				expect(target).not.toMatch(/(^~|\/\.grok\/|\/home\/|^\/Users\/)/);
			}
		});

		it('copies no credential into the overlay: only the bridge env, with the proof as a path', () => {
			const token = 'a'.repeat(64);
			const inj = buildMcpInjection(production, bridge, at(ownedRoot));
			const serialized = JSON.stringify(inj);
			expect(serialized).not.toContain(token);
			expect(serialized).not.toMatch(/XAI_API_KEY|GROK_API_KEY|Authorization|Bearer/i);
			expect(inj.files[0].content).toContain('MAESTRO_PLUGIN_RUN_TOKEN_FILE');
		});

		it('leaves the Grok argv as the caller built it', () => {
			const args = ['agent', 'stdio'];
			const inj = buildMcpInjection(production, bridge, at(ownedRoot));
			expect(mergeMcpInjectionArgs(production, args, inj.globalArgs)).toEqual(args);
		});
	});

	describe('mcpInjectionProblem - the one admission rule', () => {
		it('refuses the production entry for every version: nothing is qualified yet', () => {
			for (const version of [undefined, null, '', '0.1.200', '9.9.9']) {
				expect(mcpInjectionProblem(production, { version })).toBe('unverified');
			}
		});

		it('refuses an agent with no strategy', () => {
			expect(mcpInjectionProblem(undefined, { version: '0.1.200' })).toBe('no-strategy');
		});

		// An overlay is admitted only with the native config facts read.
		const nativeConfig = { disabledServers: [], projectServers: [] };

		it('admits only an exactly listed version, never an assumed range or an unknown one', () => {
			expect(mcpInjectionProblem(qualified, { version: '0.1.200', nativeConfig })).toBeUndefined();
			expect(
				mcpInjectionProblem(qualified, { version: '  0.1.200\n', nativeConfig })
			).toBeUndefined();
			for (const version of [
				undefined,
				null,
				'',
				'   ',
				'0.1.201',
				'0.1.20',
				'0.1.200-beta',
				'v0.1.200',
			]) {
				expect(mcpInjectionProblem(qualified, { version })).toBe('version-unqualified');
			}
			expect(
				mcpInjectionProblem({ ...qualified, qualifiedVersions: [] }, { version: '0.1.200' })
			).toBe('version-unqualified');
		});

		it('refuses a remote target, so no owned file lands on the wrong machine', () => {
			expect(mcpInjectionProblem(qualified, { version: '0.1.200', remote: true })).toBe(
				'remote-unsupported'
			);
		});

		it("refuses rather than replacing a GROK_CONFIG_PATH the user's environment already names", () => {
			expect(
				mcpInjectionProblem(qualified, {
					version: '0.1.200',
					env: { GROK_CONFIG_PATH: '/Users/me/.grok/work.toml' },
				})
			).toBe('config-path-conflict');
		});

		it('treats a blank GROK_CONFIG_PATH as unset, and other variables as irrelevant', () => {
			for (const value of [undefined, '', '   ']) {
				expect(
					mcpInjectionProblem(qualified, {
						version: '0.1.200',
						env: { GROK_CONFIG_PATH: value, XAI_API_KEY: 'secret', OPENCODE_CONFIG: '/x' },
						nativeConfig,
					})
				).toBeUndefined();
			}
		});

		it('checks verification before version, and version before the target', () => {
			expect(mcpInjectionProblem(production, { version: '0.1.200', remote: true })).toBe(
				'unverified'
			);
			expect(mcpInjectionProblem(qualified, { version: '1.0.0', remote: true })).toBe(
				'version-unqualified'
			);
		});
	});

	describe('MCP_CONFIG_BY_AGENT.grok', () => {
		it('stays unverified with no qualified version, pinned to its schema source', () => {
			expect(production).toMatchObject({
				strategy: 'grok-config-overlay',
				verified: false,
				envVar: 'GROK_CONFIG_PATH',
				fileName: 'config.toml',
				qualifiedVersions: [],
			});
			expect(production.schemaSource).toMatch(/^xai-org\/grok-build@[0-9a-f]{40}$/);
		});

		it('proves required plugin tools only by host observation, and is the only entry that does', () => {
			expect(production.toolEvidence).toBe('observed');
			for (const [id, cap] of Object.entries(MCP_CONFIG_BY_AGENT)) {
				if (id !== 'grok') expect(cap.toolEvidence).toBeUndefined();
			}
		});
	});
});

// Synthetic native MCP state and trust fixtures. They pin the
// contract native qualification executes; they certify no native Grok behavior.
describe('Grok native MCP state and trust', () => {
	const qualified: McpConfigCapability = {
		...MCP_CONFIG_BY_AGENT.grok,
		verified: true,
		qualifiedVersions: ['0.1.200'],
	};
	const read = { disabledServers: [] as string[], projectServers: [] as string[] };
	const admit = (env: Record<string, string | undefined>, nativeConfig = read) =>
		mcpInjectionProblem(qualified, { version: '0.1.200', env, nativeConfig });
	const allScanners = GROK_COMPAT_VENDORS.flatMap((v) =>
		GROK_COMPAT_RESOURCES.map((r) => grokCompatScannerEnvName(v, r))
	);
	const ok: GrokMcpServerObservation = {
		name: 'fixture',
		enabled: true,
		auth: 'none',
		handshake: 'ok',
		advertised: true,
	};

	describe('disabled servers are preserved', () => {
		it('refuses the overlay rather than re-enabling a user-disabled bridge, from either disable form', () => {
			expect(admit({}, { ...read, disabledServers: [MCP_SERVER_NAME] })).toBe('server-disabled');
			expect(admit({}, { ...read, disabledServers: ['other'] })).toBeUndefined();
			expect(admit({}, { ...read, projectServers: [MCP_SERVER_NAME] })).toBe('server-shadowed');
			expect(admit({})).toBeUndefined();
		});

		it('keeps a disabled server disabled whatever it would otherwise report, with no action or login', () => {
			for (const over of [
				{},
				{ executed: true },
				{ auth: 'oauth', authState: 'required' as const },
				{ handshake: 'failed' as const },
			]) {
				expect(classifyGrokMcpServer({ ...ok, ...over, enabled: false })).toEqual({
					name: 'fixture',
					state: 'disabled',
					usable: false,
					action: null,
					interactiveLogin: false,
				});
			}
		});
	});

	describe('synthetic auth and handshake outcomes are never tool readiness', () => {
		it.each([
			['oauth-required', { auth: 'oauth', authState: undefined }],
			['oauth-required', { auth: 'oauth', authState: 'required' }],
			['auth-pending', { auth: 'oauth', authState: 'pending' }],
			['auth-denied', { auth: 'oauth', authState: 'denied' }],
			['auth-expired', { auth: 'bearer-token', authState: 'expired' }],
			['auth-unsupported', { auth: 'device-code' }],
			['handshake-failed', { handshake: 'timeout' }],
			['handshake-failed', { handshake: 'failed' }],
		] as const)('%s is unusable even when tools and a receipt are claimed', (state, over) => {
			const outcome = classifyGrokMcpServer({ ...ok, executed: true, ...over });
			expect(outcome).toMatchObject({ state, usable: false, interactiveLogin: false });
			expect(outcome.action).toEqual(expect.any(String));
			// A bounded line pointing at Grok's own surface: no URL, no login Maestro opens.
			expect(outcome.action).not.toMatch(/https?:|localhost|device code|maestro-cli/i);
			if (state.startsWith('oauth') || state.startsWith('auth-')) {
				expect(outcome.action).toMatch(/\/mcps|Grok directly|bearer_token_file/);
			}
		});

		it('requires a host-observed advertisement for ready and a host receipt on top for executed', () => {
			expect(classifyGrokMcpServer({ ...ok, advertised: false, executed: true })).toMatchObject({
				state: 'installed',
				usable: false,
			});
			expect(classifyGrokMcpServer({ ...ok, handshake: 'pending' })).toMatchObject({
				state: 'installed',
				usable: false,
			});
			expect(classifyGrokMcpServer({ ...ok, handshake: undefined })).toMatchObject({
				state: 'installed',
				usable: false,
			});
			expect(classifyGrokMcpServer(ok)).toMatchObject({ state: 'ready', usable: true });
			expect(classifyGrokMcpServer({ ...ok, executed: true })).toMatchObject({
				state: 'executed',
				usable: true,
			});
			expect(
				classifyGrokMcpServer({ ...ok, auth: 'oauth', authState: 'authorized' })
			).toMatchObject({ state: 'ready', action: null });
		});

		it('bounds and sanitizes a hostile server name inside every action line', () => {
			const name = `evil"\n[mcp_servers.x]${'z'.repeat(200)}`;
			const { action } = classifyGrokMcpServer({ ...ok, name, handshake: 'timeout' });
			expect(action).not.toContain('\n');
			expect(action).not.toContain('[mcp_servers');
			expect(action!.length).toBeLessThan(400);
		});
	});

	describe('trust and disable changes across fresh and resumed turns', () => {
		const scope = { account: 'fixture-account', host: 'fixture-host' };
		const generation = (env: Record<string, string>) =>
			grokAcpConfigGeneration({ command: '/usr/local/bin/grok', cwd: '/repo', env, scope });

		it('states every hooks, MCP (plugin), skills, agents, rules and sessions scanner, blank as native-default', () => {
			expect(allScanners).toHaveLength(18);
			const unset = readGrokNativeTrust({});
			expect(unset.folderTrust).toBe('native');
			expect(Object.keys(unset.scanners).sort()).toEqual([...allScanners].sort());
			expect(new Set(Object.values(unset.scanners))).toEqual(new Set(['native-default']));
			const stated = readGrokNativeTrust({
				GROK_CLAUDE_HOOKS_ENABLED: '0',
				GROK_CURSOR_MCPS_ENABLED: 'false',
				GROK_CODEX_SKILLS_ENABLED: 'TRUE',
				GROK_CLAUDE_AGENTS_ENABLED: ' 1 ',
				GROK_CODEX_RULES_ENABLED: '  ',
			});
			expect(stated.scanners).toMatchObject({
				GROK_CLAUDE_HOOKS_ENABLED: 'disabled',
				GROK_CURSOR_MCPS_ENABLED: 'disabled',
				GROK_CODEX_SKILLS_ENABLED: 'enabled',
				GROK_CLAUDE_AGENTS_ENABLED: 'enabled',
				GROK_CODEX_RULES_ENABLED: 'native-default',
			});
			expect(grokNativeTrustProblem(stated)).toBeUndefined();
		});

		it.each(allScanners)(
			'moves the bound generation when %s is enabled or disabled between turns',
			(name) => {
				const fresh = generation({ PATH: '/bin' });
				// The resumed turn of an unchanged tab shares the generation, Maestro facts aside.
				expect(generation({ PATH: '/bin', MAESTRO_TURN: 'resumed' })).toBe(fresh);
				const off = generation({ PATH: '/bin', [name]: '0' });
				const on = generation({ PATH: '/bin', [name]: '1' });
				expect(new Set([fresh, off, on]).size).toBe(3);
			}
		);

		it('admits a fresh turn and refuses the resumed one once folder trust is ungated or a cell is invalid', () => {
			expect(admit({ GROK_CLAUDE_HOOKS_ENABLED: '0' })).toBeUndefined();
			expect(admit({ GROK_FOLDER_TRUST: '0' })).toBe('folder-trust-ungated');
			expect(admit({ GROK_FOLDER_TRUST: 'maybe' })).toBe('trust-setting-invalid');
			expect(admit({ GROK_CODEX_AGENTS_ENABLED: 'yes' })).toBe('trust-setting-invalid');
			expect(generation({ GROK_FOLDER_TRUST: '0' })).not.toBe(generation({}));
		});

		it('checks trust before reading native facts, so an untrusted spawn needs no user file read', () => {
			expect(mcpInjectionProblem(qualified, { version: '0.1.200', env: {} })).toBe(
				'native-config-unread'
			);
			expect(
				mcpInjectionProblem(qualified, { version: '0.1.200', env: { GROK_FOLDER_TRUST: 'false' } })
			).toBe('folder-trust-ungated');
			// A disabled bridge is still refused with trust stated: never re-enabled by an overlay.
			expect(
				admit({ GROK_FOLDER_TRUST: '1' }, { ...read, disabledServers: [MCP_SERVER_NAME] })
			).toBe('server-disabled');
		});

		it('keeps production Grok refused before any trust or native fact is consulted', () => {
			for (const env of [{}, { GROK_FOLDER_TRUST: '0' }, { GROK_CLAUDE_MCPS_ENABLED: 'x' }]) {
				expect(
					mcpInjectionProblem(MCP_CONFIG_BY_AGENT.grok, {
						version: '0.1.200',
						env,
						nativeConfig: read,
					})
				).toBe('unverified');
			}
		});
	});
});
