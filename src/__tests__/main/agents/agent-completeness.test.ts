/**
 * Agent Completeness Validation Tests
 *
 * Ensures every agent in AGENT_DEFINITIONS has all required pieces:
 * - Capabilities defined in AGENT_CAPABILITIES
 * - Output parser registered (if supportsJsonOutput)
 * - Session storage registered (if supportsSessionStorage)
 * - Error patterns registered (if has output parser)
 *
 * This test catches incomplete agent additions at CI time.
 * When adding a new agent, if this test fails it tells you exactly what's missing.
 *
 * SCOPE: this validates ONLY the built-in (compile-time) agents - the AGENT_IDS
 * tuple and its statically-typed AGENT_DEFINITIONS / AGENT_CAPABILITIES / parser
 * / storage tables. Runtime agents registered by plugins (the AgentRegistry,
 * shared/plugins/agent-registry.ts) deliberately live OUTSIDE these static
 * structures: they are not part of the AgentId union and must not be required to
 * appear in AGENT_DEFINITIONS. A plugin agent's completeness is guaranteed by
 * construction in its contribution validator + the registry, and covered by
 * agent-registry.test.ts. Do NOT make AGENT_IDS dynamic to include plugin agents
 * - that would break the exhaustiveness this test protects.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

// Install before importing storage: a beforeAll mock is too late for transitive
// module initialization. MAESTRO_USER_DATA does not relocate electron-store's
// plain-Node preferences fallback. No fixture files or operator stores are needed.
const isolation = await vi.hoisted(async () => {
	const { createRequire, syncBuiltinESMExports } = await import('node:module');
	const { fileURLToPath } = await import('node:url');
	const path = await import('node:path');
	const { isPathAtOrUnderRoot, normalizeWorktreePath } =
		await import('../../../shared/worktreePaths');
	const require = createRequire(import.meta.url);
	// Guard the actual CommonJS objects too. vi.mock('fs') alone cannot intercept
	// electron-store -> conf -> require('fs'). Never import the real store unguarded.
	const fs: typeof import('node:fs') = require('node:fs');
	const root = fileURLToPath(new URL('../../../../', import.meta.url));
	const userData = path.join(root, 'tmp', 'agent-completeness-unused-user-data');
	// A worktree may symlink node_modules to a shared install; module loading
	// resolves through the link, so the real directory is a module read too.
	const moduleRoots = [path.join(root, 'src'), path.join(root, 'node_modules')];
	try {
		moduleRoots.push(fs.realpathSync(path.join(root, 'node_modules')));
	} catch {
		// No node_modules at the root: nothing to resolve.
	}
	// Compute only the path, never stat/read it. Even a shell redirecting XDG or
	// APPDATA into the checkout must not make preferences a permitted module read.
	// In plain Node, conf infers the project from its caller (electron-store).
	const storeProject = require('electron-store/package.json').name;
	const preferences = normalizeWorktreePath(
		path.resolve(require('env-paths')(storeProject).config)
	);
	vi.stubEnv('MAESTRO_USER_DATA', userData);
	const blocked: Array<{ operation: string; path: string | undefined }> = [];
	const message = 'Agent completeness attempted filesystem access outside its in-memory fixture';
	const restores: Array<() => void> = [];

	// Collection can fail before any test runs. Put safe details in the error
	// itself so JSON reporters retain the refused operation without home paths,
	// preferences names, file contents or raw call arguments. This does no I/O.
	function describeBlockedAccess({ operation, path: file }: (typeof blocked)[number]): string {
		let target = '<non-path>';
		if (file) {
			const normalized = normalizeWorktreePath(file);
			if (isPathAtOrUnderRoot(normalized, preferences)) {
				target = '<preferences>';
			} else if (isPathAtOrUnderRoot(normalized, normalizeWorktreePath(userData))) {
				target = '<fixture-user-data>';
			} else if (isPathAtOrUnderRoot(normalized, normalizeWorktreePath(root))) {
				target = path.relative(root, file) || '.';
			} else {
				target = '<outside-checkout>';
			}
		}
		return JSON.stringify({ operation, target });
	}

	// Only module-loading reads may reach disk. Registration has no reason to
	// read transcripts, preferences, caches or even the synthetic user-data root.
	function guard(target: object, operations: readonly string[], moduleReads = false): void {
		for (const operation of operations) {
			const original = Reflect.get(target, operation);
			if (typeof original !== 'function') continue;
			const spy = vi.spyOn(target as Record<string, (...args: unknown[]) => unknown>, operation);
			spy.mockImplementation((...args: unknown[]) => {
				const input = args[0];
				const file =
					input instanceof URL
						? fileURLToPath(input)
						: typeof input === 'string' || Buffer.isBuffer(input)
							? path.resolve(input.toString())
							: undefined;
				const options = args[1];
				const flags = operation.startsWith('open')
					? options
					: options && typeof options === 'object'
						? Reflect.get(options, operation === 'createReadStream' ? 'flags' : 'flag')
						: undefined;
				if (
					moduleReads &&
					(flags === undefined ||
						flags === 'r' ||
						flags === 'rs' ||
						flags === fs.constants.O_RDONLY) &&
					file &&
					!isPathAtOrUnderRoot(normalizeWorktreePath(file), preferences) &&
					(file === path.join(root, 'package.json') ||
						moduleRoots.some((dir) =>
							isPathAtOrUnderRoot(normalizeWorktreePath(file), normalizeWorktreePath(dir))
						))
				) {
					return Reflect.apply(original, target, args);
				}
				blocked.push({ operation, path: file });
				// Not ENOENT: conf treats that as permission to write defaults.
				throw new Error(`${message}: ${describeBlockedAccess({ operation, path: file })}`);
			});
			restores.push(() => spy.mockRestore());
		}
	}
	guard(
		fs,
		[
			'readFileSync',
			'readFile',
			'readdirSync',
			'readdir',
			'accessSync',
			'access',
			'existsSync',
			'statSync',
			'stat',
			'lstatSync',
			'lstat',
			'createReadStream',
			'open',
			'openSync',
		],
		true
	);
	guard(fs.promises, ['readFile', 'readdir', 'access', 'stat', 'lstat', 'open'], true);
	const mutations = [
		'writeFile',
		'appendFile',
		'mkdir',
		'mkdtemp',
		'rm',
		'rmdir',
		'unlink',
		'rename',
		'copyFile',
		'cp',
		'symlink',
		'link',
		'truncate',
		'chmod',
		'chown',
		'utimes',
	];
	guard(fs, [...mutations, ...mutations.map((name) => `${name}Sync`), 'createWriteStream']);
	guard(fs.promises, mutations);
	syncBuiltinESMExports();

	// Reuse the in-memory get/set/store pattern from claude-session-storage.test.
	// Each constructor owns its defaults, so accidental extra stores are observable.
	const stores: Array<{
		options: { name: string; defaults: Record<string, unknown> };
		store: Record<string, unknown>;
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
	}> = [];
	const Store = vi.fn(function (options: { name: string; defaults: Record<string, unknown> }) {
		const store = structuredClone(options.defaults);
		const instance = {
			options,
			store,
			get: vi.fn((key: string, fallback?: unknown) => store[key] ?? fallback),
			set: vi.fn((key: string, value: unknown) => {
				store[key] = value;
			}),
		};
		stores.push(instance);
		return instance;
	});
	return {
		Store,
		stores,
		blocked,
		diagnostics: () => blocked.map(describeBlockedAccess),
		message,
		root: path.resolve(root),
		userData,
		fs,
		require,
		restore: () => {
			for (const restore of restores.reverse()) restore();
			syncBuiltinESMExports();
			vi.unstubAllEnvs();
		},
	};
});

vi.mock('electron-store', () => ({ default: isolation.Store }));

import path from 'node:path';
import { readFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { AGENT_DEFINITIONS, AGENT_CAPABILITIES, getAgentCapabilities } from '../../../main/agents';
import { initializeOutputParsers, getOutputParser, getErrorPatterns } from '../../../main/parsers';
import { getSessionStorage, clearStorageRegistry } from '../../../main/agents/session-storage';
import {
	initializeSessionStorages,
	ClaudeSessionStorage,
	CodexSessionStorage,
	OpenCodeSessionStorage,
	FactoryDroidSessionStorage,
	CopilotSessionStorage,
	OmpSessionStorage,
	GrokSessionStorage,
	AntigravitySessionStorage,
} from '../../../main/storage';
import { resolveUserDataDir } from '../../../shared/userDataDir';
import { AGENT_IDS } from '../../../shared/agentIds';
import {
	GROK_CAPABILITY_EVIDENCE,
	GROK_DIRECTORY_GRANT_SUPPORT,
} from '../../../shared/maestro-lib/providers/capabilities';
import {
	GROK_ACP_PORT_SUPPORT,
	isGrokRouteDecisionCurrent,
	selectGrokRoute,
	type GrokRouteSnapshot,
} from '../../../shared/maestro-lib/grok/route';
import { GROK_ACP_PROTOCOL_VERSION } from '../../../shared/maestro-lib/grok/acp-protocol';
import { buildAcpPromptFileContent } from '../../../shared/maestro-lib/launch/image-refs';
import {
	AGENT_AUTOSELECT_ORDER,
	AGENT_PICKER_META,
	PICKABLE_AGENT_IDS,
	getAgentDisplayName,
	getAgentLoginCommand,
} from '../../../shared/agentMetadata';
import { createAgentRegistry } from '../../../shared/plugins/agent-registry';
import * as sharedProviderCapabilities from '../../../shared/maestro-lib/providers/capabilities';
import * as sharedProviderDefinitions from '../../../shared/maestro-lib/providers/definitions';
import * as mainCapabilities from '../../../main/agents/capabilities';
import * as mainDefinitions from '../../../main/agents/definitions';
import { AGENT_DISPLAY_NAMES, isBetaAgent } from '../../../shared/agentMetadata';
import { COMBINED_CONTEXT_AGENTS, DEFAULT_CONTEXT_WINDOWS } from '../../../shared/agentConstants';
import { SYNOPSIS_PROVIDER_PREFERENCE } from '../../../shared/directorNotesProvider';
import {
	PROVIDER_PROFILE_CONFIGS,
	resolveAgentAccountKey,
	resolveAgentProfile,
} from '../../../shared/providerProfiles';
import { PROVIDER_ENV_VAR_SUGGESTIONS } from '../../../shared/envVarCatalog';
import { MCP_CONFIG_BY_AGENT, mcpInjectionProblem } from '../../../shared/plugins/mcp-agent-config';
import { resolveAgentAccountDir } from '../../../shared/agentAccountDir';
import {
	resolveTierModel,
	supportsEffortSelection,
	supportsTierSelection,
} from '../../../shared/modelTiers';

beforeAll(() => {
	initializeOutputParsers();
	clearStorageRegistry();
	initializeSessionStorages();
	// A swallowed access error must fail too, including one during module import.
	expect(isolation.diagnostics()).toEqual([]);
	expect(isolation.Store).toHaveBeenCalledExactlyOnceWith({
		name: 'claude-session-origins',
		defaults: { origins: {} },
	});
});

afterAll(() => {
	clearStorageRegistry();
	isolation.restore();
});

afterEach(() => {
	// Negative controls drain only their own expected refusals in finally blocks.
	expect(isolation.diagnostics()).toEqual([]);
});

describe('Agent completeness storage isolation', () => {
	it('registers every real adapter behind the in-memory store boundary', () => {
		for (const [id, Adapter] of [
			['claude-code', ClaudeSessionStorage],
			['codex', CodexSessionStorage],
			['opencode', OpenCodeSessionStorage],
			['factory-droid', FactoryDroidSessionStorage],
			['copilot-cli', CopilotSessionStorage],
			['omp', OmpSessionStorage],
			['grok', GrokSessionStorage],
			['antigravity', AntigravitySessionStorage],
		] as const) {
			expect(getSessionStorage(id)).toBeInstanceOf(Adapter);
		}
	});

	it('round-trips origin changes through the real adapter without a disk store', () => {
		const storage = getSessionStorage('claude-code') as ClaudeSessionStorage;
		const project = path.join(isolation.userData, 'synthetic-project');
		storage.registerSessionOrigin(project, 'synthetic-session', 'user');
		storage.updateSessionName(project, 'synthetic-session', 'Fixture name');
		expect(storage.getSessionOrigins(project)).toEqual({
			'synthetic-session': { origin: 'user', sessionName: 'Fixture name' },
		});
		expect(isolation.stores).toHaveLength(1);
		expect(isolation.stores[0].get).toHaveBeenCalled();
		expect(isolation.stores[0].set).toHaveBeenCalledWith('origins', {
			[project]: { 'synthetic-session': { origin: 'user', sessionName: 'Fixture name' } },
		});
	});

	it('blocks the real Node preferences fallback even with MAESTRO_USER_DATA set', () => {
		// Bypass only the Store mock, never the underlying filesystem guard. The
		// real dependency chooses its path; no preferences contents are inspected.
		const NativeStore = isolation.require('electron-store');
		const envPaths = isolation.require('env-paths');
		expect(isolation.require('electron').app).toBeUndefined();
		expect(resolveUserDataDir()).toBe(isolation.userData);
		const fallback = path.resolve(
			envPaths(isolation.require('electron-store/package.json').name).config,
			'claude-session-origins.json'
		);
		expect(fallback).not.toBe(path.join(isolation.userData, 'claude-session-origins.json'));
		try {
			expect(
				() =>
					new NativeStore({
						name: 'claude-session-origins',
						defaults: { origins: {} },
					})
			).toThrow(
				new Error(
					`${isolation.message}: ${JSON.stringify({ operation: 'readFileSync', target: '<preferences>' })}`
				)
			);
			expect(isolation.blocked).toEqual([{ operation: 'readFileSync', path: fallback }]);
		} finally {
			isolation.blocked.length = 0;
		}
	});

	it.each(['string', 'buffer', 'url'] as const)(
		'refuses %s paths before reading preferences',
		(kind) => {
			const file = path.join(isolation.userData, 'claude-session-origins.json');
			const input =
				kind === 'buffer' ? Buffer.from(file) : kind === 'url' ? pathToFileURL(file) : file;
			const diagnostic = JSON.stringify({
				operation: 'readFileSync',
				target: '<fixture-user-data>',
			});
			try {
				expect(() => readFileSync(input)).toThrow(new Error(`${isolation.message}: ${diagnostic}`));
				expect(isolation.diagnostics()).toEqual([diagnostic]);
				expect(isolation.blocked).toEqual([{ operation: 'readFileSync', path: file }]);
			} finally {
				isolation.blocked.length = 0;
			}
		}
	);

	it('reports refused checkout-root metadata without allowing a guessed loader exception', () => {
		const diagnostic = JSON.stringify({ operation: 'statSync', target: '.' });
		try {
			expect(() => isolation.fs.statSync(isolation.root)).toThrow(
				new Error(`${isolation.message}: ${diagnostic}`)
			);
			expect(isolation.diagnostics()).toEqual([diagnostic]);
			expect(isolation.blocked).toEqual([{ operation: 'statSync', path: isolation.root }]);
		} finally {
			isolation.blocked.length = 0;
		}
	});

	it('reports checkout-relative module paths while still refusing writes', () => {
		const relative = path.join('src', 'synthetic-module.ts');
		const file = path.join(isolation.root, relative);
		const diagnostic = JSON.stringify({ operation: 'writeFileSync', target: relative });
		try {
			expect(() => isolation.fs.writeFileSync(file, 'synthetic-private-content')).toThrow(
				new Error(`${isolation.message}: ${diagnostic}`)
			);
			expect(isolation.diagnostics()).toEqual([diagnostic]);
			expect(isolation.blocked).toEqual([{ operation: 'writeFileSync', path: file }]);
		} finally {
			isolation.blocked.length = 0;
		}
	});

	it.each(['string', 'buffer', 'url'] as const)(
		'redacts outside-checkout %s targets before refusing the read',
		(kind) => {
			// A sibling sharing the checkout's prefix must not be reported as local.
			// This is a synthetic path; the guard refuses it before touching disk.
			const file = path.join(`${isolation.root}-private`, 'synthetic-private-account.json');
			const input =
				kind === 'buffer' ? Buffer.from(file) : kind === 'url' ? pathToFileURL(file) : file;
			const diagnostic = JSON.stringify({
				operation: 'readFileSync',
				target: '<outside-checkout>',
			});
			try {
				expect(() => readFileSync(input)).toThrow(new Error(`${isolation.message}: ${diagnostic}`));
				expect(isolation.diagnostics()).toEqual([diagnostic]);
				expect(isolation.blocked).toEqual([{ operation: 'readFileSync', path: file }]);
			} finally {
				isolation.blocked.length = 0;
			}
		}
	);

	it('omits file descriptors from refusal diagnostics', () => {
		const diagnostic = JSON.stringify({ operation: 'readFileSync', target: '<non-path>' });
		try {
			expect(() => readFileSync(0)).toThrow(new Error(`${isolation.message}: ${diagnostic}`));
			expect(isolation.diagnostics()).toEqual([diagnostic]);
			expect(isolation.blocked).toEqual([{ operation: 'readFileSync', path: undefined }]);
		} finally {
			isolation.blocked.length = 0;
		}
	});

	it('refuses synchronous and promise reads/writes and directory creation', async () => {
		const file = path.join(isolation.userData, 'maestro-settings.json');
		try {
			expect(() => isolation.fs.writeFileSync(file, '{}')).toThrow(isolation.message);
			expect(() => isolation.fs.mkdirSync(isolation.userData, { recursive: true })).toThrow(
				isolation.message
			);
			await expect(Promise.resolve().then(() => fsPromises.readFile(file))).rejects.toThrow(
				isolation.message
			);
			await expect(Promise.resolve().then(() => fsPromises.writeFile(file, '{}'))).rejects.toThrow(
				isolation.message
			);
			await expect(
				Promise.resolve().then(() => fsPromises.mkdir(isolation.userData))
			).rejects.toThrow(isolation.message);
			expect(isolation.blocked.map(({ operation }) => operation)).toEqual([
				'writeFileSync',
				'mkdirSync',
				'readFile',
				'writeFile',
				'mkdir',
			]);
		} finally {
			isolation.blocked.length = 0;
		}
	});
});

describe('Agent Completeness', () => {
	describe('AGENT_IDS ↔ AGENT_DEFINITIONS consistency', () => {
		it('every agent in AGENT_DEFINITIONS should have an ID in AGENT_IDS', () => {
			for (const def of AGENT_DEFINITIONS) {
				expect(
					AGENT_IDS.includes(def.id as (typeof AGENT_IDS)[number]),
					`Agent "${def.id}" is in AGENT_DEFINITIONS but not in AGENT_IDS (shared/agentIds.ts)`
				).toBe(true);
			}
		});

		it('every ID in AGENT_IDS should have a definition in AGENT_DEFINITIONS', () => {
			const definedIds = AGENT_DEFINITIONS.map((d) => d.id);
			for (const id of AGENT_IDS) {
				expect(
					definedIds.includes(id),
					`Agent ID "${id}" is in AGENT_IDS but not in AGENT_DEFINITIONS (agents/definitions.ts)`
				).toBe(true);
			}
		});
	});

	describe('per-agent completeness', () => {
		for (const def of AGENT_DEFINITIONS) {
			describe(`${def.id}`, () => {
				it('has capabilities defined in AGENT_CAPABILITIES', () => {
					expect(
						AGENT_CAPABILITIES[def.id],
						`Agent "${def.id}" is missing from AGENT_CAPABILITIES (agents/capabilities.ts)`
					).toBeDefined();
				});

				it('has all required capability fields', () => {
					const caps = AGENT_CAPABILITIES[def.id];
					if (!caps) return; // Covered by previous test

					const requiredBooleanFields = [
						'supportsResume',
						'supportsReadOnlyMode',
						'supportsJsonOutput',
						'supportsSessionId',
						'supportsImageInput',
						'supportsImageInputOnResume',
						'supportsSlashCommands',
						'supportsSessionStorage',
						'supportsCostTracking',
						'supportsUsageStats',
						'supportsBatchMode',
						'supportsStreaming',
						'supportsResultMessages',
						'supportsModelSelection',
						'requiresPromptToStart',
						'supportsStreamJsonInput',
						'supportsPromptViaStdin',
						'supportsThinkingDisplay',
						'supportsContextMerge',
						'supportsContextExport',
						'supportsAdditionalDirectories',
					];

					for (const field of requiredBooleanFields) {
						expect(
							typeof (caps as Record<string, unknown>)[field],
							`Agent "${def.id}" is missing capability field "${field}"`
						).toBe('boolean');
					}
				});

				// The capability boolean and the arg builder are two halves of one
				// feature: the boolean drives UI copy ("enforced by the provider" vs
				// "instructions only") while the builder produces the actual flags.
				// Let them drift and the UI promises enforcement that never ships.
				it('declares additionalDirArgs iff supportsAdditionalDirectories', () => {
					const caps = getAgentCapabilities(def.id);

					if (caps.supportsAdditionalDirectories) {
						expect(
							typeof def.additionalDirArgs,
							`Agent "${def.id}" has supportsAdditionalDirectories=true but no additionalDirArgs() in agents/definitions.ts, so its grants would silently never reach the CLI`
						).toBe('function');
					} else {
						expect(
							def.additionalDirArgs,
							`Agent "${def.id}" defines additionalDirArgs() but supportsAdditionalDirectories=false, so the args are built and the UI still tells the user nothing is enforced`
						).toBeUndefined();
					}
				});

				it('emits no directory args when the agent has no grants', () => {
					// Guards the common spawn case: an agent with an empty grant list
					// must not gain a stray flag (a bare `--add-dir` with no value would
					// eat the next arg, which on several paths is the prompt).
					expect(def.additionalDirArgs?.([]) ?? []).toEqual([]);
				});

				it('has output parser if supportsJsonOutput', () => {
					const caps = getAgentCapabilities(def.id);
					if (caps.supportsJsonOutput) {
						expect(
							getOutputParser(def.id),
							`Agent "${def.id}" has supportsJsonOutput=true but no output parser registered`
						).not.toBeNull();
					}
				});

				it('has session storage if supportsSessionStorage', () => {
					const caps = getAgentCapabilities(def.id);
					if (caps.supportsSessionStorage) {
						expect(
							getSessionStorage(def.id),
							`Agent "${def.id}" has supportsSessionStorage=true but no session storage registered`
						).not.toBeNull();
					}
				});

				it('has error patterns if has output parser', () => {
					const parser = getOutputParser(def.id);
					if (parser) {
						const patterns = getErrorPatterns(def.id);
						expect(
							Object.keys(patterns).length,
							`Agent "${def.id}" has an output parser but no error patterns registered`
						).toBeGreaterThan(0);
					}
				});
			});
		}
	});

	it('keeps unqualified Grok directory-grant evidence separate from public availability', () => {
		// Pinned-source ACP resume rejects roots; CLI read/write roots have no
		// qualified version. Neither investigation result authorizes native grants.
		expect(GROK_DIRECTORY_GRANT_SUPPORT).toEqual({
			cliReadRoots: 'unverified',
			cliWritableRoots: 'unverified',
			acpResumeRoots: 'unsupported',
			supportedVersionRange: null,
		});
		const grok = AGENT_DEFINITIONS.find((def) => def.id === 'grok');
		expect(grok).toBeDefined();
		expect(grok?.additionalDirArgs).toBeUndefined();
		expect(getAgentCapabilities('grok').supportsAdditionalDirectories).toBe(false);
	});

	// Grok's canonical registration. Each registry a
	// provider joins is keyed by the canonical id, so a renamed id, an alias or a
	// half-finished addition fails here instead of silently falling back.
	describe('Grok canonical registration', () => {
		const ids = new Set<string>(AGENT_IDS);
		const keyedRegistries: Array<[string, Iterable<string>]> = [
			['AGENT_DISPLAY_NAMES', Object.keys(AGENT_DISPLAY_NAMES)],
			['AGENT_PICKER_META', Object.keys(AGENT_PICKER_META)],
			['DEFAULT_CONTEXT_WINDOWS', Object.keys(DEFAULT_CONTEXT_WINDOWS)],
			['SYNOPSIS_PROVIDER_PREFERENCE', SYNOPSIS_PROVIDER_PREFERENCE],
			['PROVIDER_PROFILE_CONFIGS', Object.keys(PROVIDER_PROFILE_CONFIGS)],
			['PROVIDER_ENV_VAR_SUGGESTIONS', Object.keys(PROVIDER_ENV_VAR_SUGGESTIONS)],
			['MCP_CONFIG_BY_AGENT', Object.keys(MCP_CONFIG_BY_AGENT)],
			['AGENT_CAPABILITIES', Object.keys(AGENT_CAPABILITIES)],
		];

		it('keys every provider registry by a canonical agent id, never an alias', () => {
			for (const [name, keys] of keyedRegistries) {
				for (const key of keys) {
					expect(ids.has(key), `${name} has "${key}", which is not in AGENT_IDS`).toBe(true);
				}
			}
			// One Grok id, spelled once; no `grok-cli`, `xai` or `grok-build` alias.
			expect(AGENT_IDS.filter((id) => /grok|xai/i.test(id))).toEqual(['grok']);
		});

		it('names Grok identically across the definition, metadata and login registries', () => {
			const def = AGENT_DEFINITIONS.find((d) => d.id === 'grok');
			expect(def).toMatchObject({ id: 'grok', binaryName: 'grok', command: 'grok' });
			expect(def?.hidden).toBeFalsy();
			expect(def?.name).toBe(AGENT_DISPLAY_NAMES.grok);
			expect(getAgentDisplayName('grok')).toBe('Grok CLI');
			expect(isBetaAgent('grok')).toBe(true);
			expect(PICKABLE_AGENT_IDS).toContain('grok');
			expect(getAgentLoginCommand('grok')?.binary).toBe(def?.binaryName);
			// Reachable through the alphabetical fallback, never preferred (A11-F06).
			expect(AGENT_AUTOSELECT_ORDER).not.toContain('grok');
		});

		it('joins every registry the comparators join, with its deliberate exclusions intact', () => {
			expect(getOutputParser('grok')).not.toBeNull();
			expect(getSessionStorage('grok')).toBeInstanceOf(GrokSessionStorage);
			expect(Object.keys(getErrorPatterns('grok')).length).toBeGreaterThan(0);
			expect(MCP_CONFIG_BY_AGENT.grok?.strategy).toBe('grok-config-overlay');
			expect(PROVIDER_PROFILE_CONFIGS.grok).toEqual({
				envVar: 'GROK_HOME',
				defaultSubdir: '.grok',
				sessionsSubdir: 'sessions',
			});
			// Present with an unknown window on purpose, not missing.
			expect(Object.prototype.hasOwnProperty.call(DEFAULT_CONTEXT_WINDOWS, 'grok')).toBe(true);
			expect(DEFAULT_CONTEXT_WINDOWS.grok).toBe(0);
			// Last on purpose: a synopsis is a read-only batch turn.
			expect(SYNOPSIS_PROVIDER_PREFERENCE.at(-1)).toBe('grok');
			expect(supportsEffortSelection('grok')).toBe(true);
			// No stable three-tier catalog: the configured model stays in charge.
			expect(supportsTierSelection('grok')).toBe(false);
			expect(resolveTierModel('grok', 'high')).toBeUndefined();
		});

		it('suggests the profile env var in the env catalog for every provider', () => {
			for (const [toolType, config] of Object.entries(PROVIDER_PROFILE_CONFIGS)) {
				expect(
					PROVIDER_ENV_VAR_SUGGESTIONS[toolType]?.map((s) => s.key) ?? [],
					`${toolType}: the env catalog must suggest ${config.envVar}`
				).toContain(config.envVar);
			}
		});

		it('propagates the effective Grok profile from the layer the process receives', () => {
			const homeDir = path.join(isolation.userData, 'home');
			const work = path.join(homeDir, '.grok-work');
			const provider = path.join(homeDir, '.grok-provider');
			const shell = path.join(homeDir, '.grok-shell');
			const dir = (customEnvVars?: Record<string, string>, sshRemote = false) =>
				resolveAgentAccountDir(
					{ toolType: 'grok', customEnvVars, sshRemote },
					{
						homeDir,
						agentLevelEnvVars: { GROK_HOME: provider },
						globalShellEnvVars: { GROK_HOME: shell },
					}
				);
			expect(dir({ GROK_HOME: work })).toBe(work);
			// No agent env: the provider-level set is inherited.
			expect(dir()).toBe(provider);
			// The agent's own vars REPLACE the provider set, so its GROK_HOME is gone
			// and the next layer (Settings -> Environment) decides.
			expect(dir({ FIXTURE_UNRELATED_VAR: 'x' })).toBe(shell);
			// A blank at the winning layer selects the default, never another account.
			expect(dir({ GROK_HOME: '' })).toBe(path.join(homeDir, '.grok'));
			// A remote path is the remote's and is not resolved on this machine.
			expect(dir({ GROK_HOME: '~/.grok-remote' }, true)).toBe('~/.grok-remote');
			// A remote agent carries only its custom layer (inherited or its own) to the
			// host; the shell and host env of this machine never reach it.
			expect(dir(undefined, true)).toBe(provider);
			expect(dir({ FIXTURE_UNRELATED_VAR: 'x' }, true)).toBeUndefined();
			// The profile reads the same selected root the launch resolves.
			const env = { GROK_HOME: work };
			expect(resolveAgentAccountKey('grok', env, homeDir)).toBe(work);
			expect(resolveAgentProfile('grok', env, homeDir)?.accountKey).toBe(work);
			// An inline bundle identifies no account: no profile, rather than a merge.
			expect(resolveAgentProfile('grok', { ...env, GROK_AUTH: '{}' }, homeDir)).toBeNull();
		});

		it('reports route-dependent truth, not a capability table of all trues', () => {
			const caps = getAgentCapabilities('grok');
			// Unqualified or withheld: each stays false until phase 11 evidence promotes it.
			for (const flag of [
				'supportsSlashCommands',
				'supportsStreamJsonInput',
				'supportsPromptViaStdin',
				'supportsGroupChatModeration',
				'usesCombinedContextWindow',
				'supportsAppendSystemPrompt',
				'supportsProjectMemory',
				'supportsAdditionalDirectories',
			] as const) {
				expect(caps[flag], flag).toBe(false);
			}
			expect(Object.values(caps).filter((v) => v === false).length).toBeGreaterThanOrEqual(8);
			// The static set agrees with the canonical flag for every provider.
			for (const id of AGENT_IDS) {
				expect(
					COMBINED_CONTEXT_AGENTS.has(id),
					`${id}: COMBINED_CONTEXT_AGENTS disagrees with usesCombinedContextWindow`
				).toBe(getAgentCapabilities(id).usesCombinedContextWindow);
			}
			const def = AGENT_DEFINITIONS.find((d) => d.id === 'grok');
			// No verified all-tools-off switch and no qualified root grant builder.
			expect(def?.noToolsArgs).toBeUndefined();
			expect(def?.additionalDirArgs).toBeUndefined();
			expect(def?.readOnlyArgs).toEqual(['--permission-mode', 'plan', '--deny', 'Bash(*)']);
			// The CLI read-only filter strips batch args only when they equal YOLO args.
			expect(def?.batchModeArgs).toEqual(def?.yoloModeArgs);
		});

		// The route selector over the finalized registry. `native.qualified`
		// is derived from the recorded qualified versions, never forced, so a version only
		// becomes native-routable when evidence names it.
		describe('route selection over the finalized registry', () => {
			const caps = getAgentCapabilities('grok');
			const versions = [
				GROK_CAPABILITY_EVIDENCE.candidateVersion,
				'1.0.41',
				'1.0.5',
				'0.2.93',
				null,
			] as const;
			const snapshotFor = (
				version: string | null,
				overrides: Partial<GrokRouteSnapshot> = {}
			): GrokRouteSnapshot => ({
				executable: { path: '/synthetic/grok' },
				agentVersion: version,
				platform: 'synthetic-arch',
				account: 'account-a',
				host: 'host-a',
				configGeneration: 'gen-1',
				target: 'local',
				native: {
					qualified:
						version !== null &&
						(GROK_CAPABILITY_EVIDENCE.qualifiedVersions as readonly string[]).includes(version),
				},
				...overrides,
			});
			const negotiated = (version: string) => ({
				protocolVersion: GROK_ACP_PROTOCOL_VERSION,
				agentVersion: version,
				loadSession: true,
				images: true,
				commands: true,
			});

			it.each(versions)('refuses the native headless route for binary %s', (version) => {
				const result = selectGrokRoute(
					{ permissionMode: 'readonly', consent: 'none' },
					snapshotFor(version)
				);
				expect(result.ok).toBe(false);
				if (result.ok) return;
				expect(result.route).toBe('native-headless');
				expect(result.missing).toContain('native-unqualified');
			});

			it('binds ACP to the version the process negotiated, never an older binary', () => {
				const req = { permissionMode: 'standard', consent: 'interactive' } as const;
				for (const version of versions) {
					if (version === null) continue;
					const ok = selectGrokRoute(req, snapshotFor(version, { acp: negotiated(version) }));
					expect(ok.ok, version).toBe(true);
				}
				// An older binary carrying the candidate's advertisement proves nothing about itself.
				const older = selectGrokRoute(
					req,
					snapshotFor('1.0.5', { acp: negotiated(GROK_CAPABILITY_EVIDENCE.candidateVersion) })
				);
				expect(older.ok).toBe(false);
				if (!older.ok) expect(older.missing).toContain('acp-version-unbound');
				const unknown = selectGrokRoute(req, snapshotFor(null, { acp: negotiated('1.0.70') }));
				expect(unknown.ok).toBe(false);
				if (!unknown.ok) expect(unknown.missing).toContain('acp-version-unbound');
				// No SSH owner for ACP: a remote target refuses rather than running locally.
				const remote = selectGrokRoute(
					req,
					snapshotFor('1.0.70', { target: 'remote', acp: negotiated('1.0.70') })
				);
				expect(remote.ok).toBe(false);
				if (!remote.ok) expect(remote.missing).toContain('acp-remote-route');
			});

			it('binds a decision to the selected profile and invalidates it when that changes', () => {
				const snapshot = snapshotFor('1.0.70', { acp: negotiated('1.0.70') });
				const decision = selectGrokRoute(
					{ permissionMode: 'standard', consent: 'interactive' },
					snapshot
				);
				expect(decision.ok).toBe(true);
				if (!decision.ok) return;
				expect(decision.facts).toMatchObject({ account: 'account-a', agentVersion: '1.0.70' });
				expect(isGrokRouteDecisionCurrent(decision, snapshot)).toBe(true);
				for (const change of [
					{ account: 'account-b' },
					{ configGeneration: 'gen-2' },
					{ agentVersion: '1.0.71', acp: negotiated('1.0.71') },
					{ executable: { path: '/synthetic/other/grok' } },
				] satisfies Partial<GrokRouteSnapshot>[]) {
					expect(isGrokRouteDecisionCurrent(decision, { ...snapshot, ...change })).toBe(false);
				}
			});

			it('refuses withheld features safely instead of advertising them', () => {
				// Images: the flag, the ACP port and the prompt-file encoder agree.
				expect(caps.supportsImageInput).toBe(false);
				expect(caps.supportsImageInputOnResume).toBe(false);
				expect(GROK_ACP_PORT_SUPPORT.images).toBe(false);
				const image = selectGrokRoute(
					{ permissionMode: 'standard', consent: 'interactive', imageCount: 1 },
					snapshotFor('1.0.70', { acp: negotiated('1.0.70') })
				);
				expect(image.ok).toBe(false);
				if (!image.ok) expect(image.missing).toEqual(['acp-images']);
				// No host producer of image bounds: an image block without them refuses the prompt.
				expect(
					buildAcpPromptFileContent([
						{ type: 'text', text: 'describe' },
						{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
					])
				).toEqual({
					ok: false,
					error: 'Embedded images require explicit support and bounded image limits.',
				});
				// Steering has no pinned input operation.
				expect(GROK_ACP_PORT_SUPPORT.steering).toBe(false);
				// MCP injection is version-scoped by the same (empty) evidence and injects nothing.
				const mcp = MCP_CONFIG_BY_AGENT.grok;
				expect(mcp?.qualifiedVersions).toEqual(GROK_CAPABILITY_EVIDENCE.qualifiedVersions);
				for (const version of versions) {
					expect(
						mcpInjectionProblem(mcp, { version: version ?? undefined }),
						String(version)
					).toBeDefined();
				}
			});
		});

		it('exports one provider table from the shared library and the main process', () => {
			expect(mainDefinitions.AGENT_DEFINITIONS).toBe(sharedProviderDefinitions.AGENT_DEFINITIONS);
			expect(mainCapabilities.AGENT_CAPABILITIES).toBe(
				sharedProviderCapabilities.AGENT_CAPABILITIES
			);
			expect(AGENT_DEFINITIONS).toBe(sharedProviderDefinitions.AGENT_DEFINITIONS);
			expect(AGENT_CAPABILITIES).toBe(sharedProviderCapabilities.AGENT_CAPABILITIES);
			expect(mainCapabilities.getAgentCapabilities('grok')).toBe(
				sharedProviderCapabilities.AGENT_CAPABILITIES.grok
			);
			expect(mainDefinitions.getAgentDefinition('grok')).toBe(
				sharedProviderDefinitions.getAgentDefinition('grok')
			);
			expect(mainCapabilities.GROK_DIRECTORY_GRANT_SUPPORT).toBe(GROK_DIRECTORY_GRANT_SUPPORT);
		});
	});

	describe('provider picker registration', () => {
		it('every agent id has a picker decision, shown or explicitly withheld', () => {
			for (const agentId of AGENT_IDS) {
				expect(
					Object.prototype.hasOwnProperty.call(AGENT_PICKER_META, agentId),
					`Agent "${agentId}" has no entry in AGENT_PICKER_META. Add presentation ` +
						'metadata to offer it in the pickers, or null to withhold it.'
				).toBe(true);
			}
		});

		it('offers providers alphabetically by display name', () => {
			// One predictable order across the New Agent modal, the wizard tile strip
			// and the Group Chat moderator dropdown, so a provider is where the user
			// expects it no matter which surface they open.
			const names = PICKABLE_AGENT_IDS.map((id) => getAgentDisplayName(id));
			expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
		});

		it('auto-selects a real pickable agent rather than whatever sorts first', () => {
			for (const agentId of AGENT_AUTOSELECT_ORDER) {
				expect(
					PICKABLE_AGENT_IDS.includes(agentId),
					`Auto-select preference "${agentId}" is not a pickable provider`
				).toBe(true);
			}
		});

		it('every pickable agent is a real, non-hidden definition', () => {
			for (const agentId of PICKABLE_AGENT_IDS) {
				const def = AGENT_DEFINITIONS.find((d) => d.id === agentId);
				expect(def, `Pickable agent "${agentId}" has no definition`).toBeDefined();
				expect(def?.hidden, `Pickable agent "${agentId}" is hidden`).toBeFalsy();
			}
		});

		// Providers that hold no credentials of their own, so `null` from
		// getAgentLoginCommand is the correct answer rather than a missing entry.
		// Pi and Oh My Pi are harnesses over a provider the user configures
		// elsewhere; Hermes ships no login flow. Adding an id here is a deliberate
		// claim that the agent cannot be logged in to, not a way to silence a gap.
		const CREDENTIALLESS_AGENTS = new Set(['hermes', 'pi', 'omp']);

		it('every pickable agent can be re-authenticated from the UI', () => {
			// A provider offered in a picker whose auth expires needs a way back in.
			// An earlier version of this test skipped a null command outright, which
			// let a genuinely missing entry pass as if it were credentialless.
			for (const agentId of PICKABLE_AGENT_IDS) {
				const login = getAgentLoginCommand(agentId);

				if (CREDENTIALLESS_AGENTS.has(agentId)) {
					expect(
						login,
						`Agent "${agentId}" is listed as credentialless but declares a login command. ` +
							'Remove it from CREDENTIALLESS_AGENTS.'
					).toBeNull();
					continue;
				}

				expect(
					login,
					`Agent "${agentId}" is pickable but has no login command. Add one to ` +
						'AGENT_LOGIN_COMMANDS, or add the id to CREDENTIALLESS_AGENTS if it ' +
						'genuinely carries no credentials.'
				).not.toBeNull();
				expect(login?.binary?.trim(), `Agent "${agentId}" has an empty login binary`).toBeTruthy();
				expect(
					typeof login?.args,
					`Agent "${agentId}" must declare args (empty string when the bare binary is the flow)`
				).toBe('string');
			}
		});
	});

	describe('no orphaned capabilities', () => {
		it('every agent in AGENT_CAPABILITIES should be in AGENT_DEFINITIONS', () => {
			const definedIds = AGENT_DEFINITIONS.map((d) => d.id);
			for (const agentId of Object.keys(AGENT_CAPABILITIES)) {
				expect(
					definedIds.includes(agentId),
					`Agent "${agentId}" is in AGENT_CAPABILITIES but not in AGENT_DEFINITIONS`
				).toBe(true);
			}
		});
	});

	// Runtime (plugin) agents are intentionally NOT subject to the static
	// completeness checks above. They are known to the registry but absent from
	// the compile-time tables, and that separation is the relaxation that lets
	// plugins add agents without touching first-party type exhaustiveness.
	describe('runtime agents live outside the static core', () => {
		it('a registered runtime agent is known but is not a built-in', () => {
			const reg = createAgentRegistry([
				{
					id: 'com.acme/bot',
					localId: 'bot',
					pluginId: 'com.acme',
					displayName: 'Bot',
					binaryName: 'bot',
					baseArgs: [],
					capabilities: {},
				},
			]);
			expect(reg.isKnown('com.acme/bot')).toBe(true);
			expect(reg.isBuiltIn('com.acme/bot')).toBe(false);
			// It must NOT leak into the static built-in structures.
			expect(AGENT_IDS.includes('com.acme/bot' as (typeof AGENT_IDS)[number])).toBe(false);
			expect(AGENT_DEFINITIONS.map((d) => d.id).includes('com.acme/bot')).toBe(false);
		});

		it('every built-in id is reported as built-in by the registry', () => {
			const reg = createAgentRegistry([]);
			for (const id of AGENT_IDS) {
				expect(reg.isBuiltIn(id), `registry should treat "${id}" as built-in`).toBe(true);
			}
		});
	});
});
