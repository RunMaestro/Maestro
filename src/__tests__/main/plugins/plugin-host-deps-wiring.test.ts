/**
 * @file plugin-host-deps-wiring.test.ts
 * @description Production-site security guard for the act verbs. The handler
 * factory contract is covered in plugin-host-handlers.test.ts; this locks the
 * ONE integration site that decides whether the arbitrary-code-execution-grade
 * verbs are reachable in the shipped app: the live `buildHostCallHandlers({...})`
 * call in src/main/index.ts.
 *
 * FC2 state (Plans/feature-complete-workplan.md): `dispatch` / `spawn` /
 * `resolveSpawnBinary` are WIRED, sanctioned by the recorded Option-B decision
 * + the phase-4 gate (allowlist scopes, separate high-risk + unattended
 * consent, host-owned binary registry, FC1 trusted-to-run gate, ActionGuard,
 * audit-before-effect). This guard now pins the CONDITIONS that made wiring
 * acceptable, so weakening any one of them fails the build and forces a
 * security review:
 *  - the spawn sink consumes the host-owned registry (`resolveSpawnBinary`
 *    wired alongside `spawn` - never one without the other);
 *  - the registry construction ships EMPTY in production (only the DEMO_MODE
 *    e2e blessing exists, env-gated);
 *  - `execFile` is used with `shell: false` (never a shell).
 *
 * Keys are read from the parsed AST (not a regex/paren scan) so strings,
 * comments, or unrelated identifiers elsewhere can't affect it.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { RELAY_PLUGIN_ID } from '../../../shared/plugins/relay-identity';
import { getProviderProfileConfig } from '../../../shared/providerProfiles';

vi.mock('../../../main/utils/logger', () => ({ logger: { warn: vi.fn() } }));
import { PluginBackgroundSupervisor } from '../../../main/plugins/plugin-background-supervisor';

const indexPath = path.join(__dirname, '../../../main/index.ts');
const source = fs.readFileSync(indexPath, 'utf-8');
const sf = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);

/** Property names of the object literal passed to the live
 * `buildHostCallHandlers({ ... })` call. */
function depsObjectKeys(): string[] {
	let keys: string[] | null = null;
	const visit = (node: ts.Node): void => {
		if (
			keys === null &&
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === 'buildHostCallHandlers'
		) {
			const arg = node.arguments[0];
			if (arg && ts.isObjectLiteralExpression(arg)) {
				keys = arg.properties
					.map((p) => {
						const name = p.name;
						if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) return name.text;
						return null;
					})
					.filter((k): k is string => k !== null);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	expect(keys, 'buildHostCallHandlers({...}) object literal not found in index.ts').not.toBeNull();
	return keys ?? [];
}

/** All `spawnBinaryRegistry.register({...})` call sites with their guard text. */
function registryRegisterCallCount(): number {
	let count = 0;
	const visit = (node: ts.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === 'register' &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text === 'spawnBinaryRegistry'
		) {
			count += 1;
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return count;
}

describe('production host-handler deps wiring (FC2 - wired and gated)', () => {
	const keys = depsObjectKeys();

	it('wires the act-verb sinks TOGETHER with the host-owned registry resolver', () => {
		// dispatch/spawn without resolveSpawnBinary would make the registry
		// unreachable and spawn an unresolvable-name denial-only surface; spawn
		// without dispatch (or vice versa) signals a partial, unreviewed edit.
		expect(keys).toContain('dispatch');
		expect(keys).toContain('spawn');
		expect(keys).toContain('resolveSpawnBinary');
	});

	it('gates direct dispatch behind the separate unattended consent (dispatch implies dispatchUnattendedAllowed)', () => {
		// Direct plugin dispatch is definitionally "nobody at the keyboard", so the
		// handler requires the unattended consent on top of the interactive
		// allowlist grant. Removing the wired predicate would silently drop that
		// gate - this pins it so doing so fails the build and forces a review.
		if (keys.includes('dispatch')) {
			expect(keys).toContain('dispatchUnattendedAllowed');
		}
	});

	it('wires title generation with the same unattended and host-owned naming path', () => {
		expect(keys).toContain('generateTitle');
		expect(keys).toContain('dispatchUnattendedAllowed');
		expect(source).toMatch(/generateTitle: async \(agentId, firstMessage, signal\) =>/);
		expect(source).toMatch(/return generateTabName\(/);
		expect(source).toMatch(/useUtilityAgent: false/);
	});

	it('still wires the safe read-only deps (guard targets the right call)', () => {
		expect(keys).toContain('listAgents');
		expect(keys).toContain('broker');
	});
	it('wires service lifecycle, live grants, trusted manifests and the existing bounded invocation channel together', () => {
		for (const key of [
			'serviceManifest',
			'serviceRunning',
			'serviceAllowed',
			'serviceInvoke',
			'serviceCancelProvider',
			'registerServiceAvailability',
			'registerServiceReconcile',
			'serviceChanged',
		])
			expect(keys).toContain(key);
	});

	it.each(['success', 'failure', 'disabled'] as const)(
		'production crash hook waits for resource drain before supervised restart (%s)',
		async (mode) => {
			vi.useFakeTimers();
			try {
				let callback: ts.ArrowFunction | undefined;
				const visit = (node: ts.Node): void => {
					if (
						ts.isPropertyAssignment(node) &&
						node.name.getText(sf) === 'onCrash' &&
						ts.isArrowFunction(node.initializer)
					)
						callback = node.initializer;
					ts.forEachChild(node, visit);
				};
				visit(sf);
				expect(callback).toBeDefined();
				const gate = Promise.withResolvers<void>();
				let drained = false;
				let enabled = true;
				const restart = vi.fn(() => {
					if (!drained) throw new Error('PluginDrainPending');
				});
				const supervisor = new PluginBackgroundSupervisor({
					restartPlugin: restart,
					isPluginEnabled: () => enabled,
				});
				supervisor.register('p', { id: 'worker' });
				const js = ts.transpileModule(`const onCrash = ${callback!.getText(sf)}`, {
					compilerOptions: { target: ts.ScriptTarget.ES2024 },
				}).outputText;
				const onCrash = new Function(
					'pluginResourceCleanup',
					'pluginHostViews',
					'groupingRegistry',
					'logger',
					'backgroundSupervisor',
					`${js}\nreturn onCrash;`
				)(
					() => gate.promise,
					{ purge: vi.fn() },
					{ removePlugin: vi.fn() },
					{ warn: vi.fn() },
					supervisor
				);
				const cleanup = onCrash('p', 1);
				expect(supervisor.health('p')).toMatchObject({ state: 'restarting', services: [] });
				await vi.advanceTimersByTimeAsync(1500);
				expect(restart).not.toHaveBeenCalled();
				if (mode === 'failure') {
					const failed = expect(cleanup).rejects.toThrow('MediaProcessFailed');
					gate.reject(new Error('MediaProcessFailed'));
					await failed;
				} else {
					if (mode === 'disabled') enabled = false;
					drained = true;
					gate.resolve();
					await cleanup;
				}
				await vi.advanceTimersByTimeAsync(1001);
				expect(restart).toHaveBeenCalledTimes(mode === 'success' ? 1 : 0);
				supervisor.stopAll();
			} finally {
				vi.useRealTimers();
			}
		}
	);

	it('wires declared host-view lookup and the Concerto forwarding seam together', () => {
		expect(keys).toContain('isHostViewsEnabled');
		expect(keys).toContain('getHostView');
		expect(keys).toContain('forwardHostView');
	});

	it('wires the panel-post sink together with the own-panel lookup', () => {
		// The sink without `getPanel` would leave the own-panels-only check with no
		// resolver, so every post would deny (or, if the check were dropped, let a
		// plugin push into another plugin's panel). Pin them as a pair.
		if (keys.includes('panelPost')) {
			expect(keys).toContain('getPanel');
		}
	});

	it('production blesses NO spawn binaries - the only register() site is the env-gated DEMO blessing', () => {
		// Exactly one register call may exist, and it must sit behind both the
		// DEMO_MODE flag and the harness env var. Adding a second call site (or
		// removing the gate) is a security review, not a refactor.
		expect(registryRegisterCallCount()).toBe(1);
		expect(source).toMatch(/DEMO_MODE && process\.env\.MAESTRO_E2E_SPAWN_BINARY/);
	});

	it('the spawn sink never uses a shell', () => {
		// execFile with explicit shell: false in the sink options object.
		expect(source).toMatch(/shell: false/);
		expect(source).not.toMatch(/shell: true/);
	});
});

describe('production Relay origin backfill', () => {
	it('respects provider account roots and skips missing or disabled SSH remotes', async () => {
		let withinBackfill = false;
		let callback: ts.ArrowFunction | undefined;
		/** Locate the production backfill using the shared host Relay identity. */
		const visit = (node: ts.Node): void => {
			if (
				ts.isIfStatement(node) &&
				node.expression.getText(sf) === 'pluginProviderSessions.hasBindings(RELAY_PLUGIN_ID)'
			) {
				withinBackfill = true;
			}
			if (
				withinBackfill &&
				!callback &&
				ts.isArrowFunction(node) &&
				node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
			) {
				callback = node;
			}
			ts.forEachChild(node, visit);
		};
		visit(sf);
		expect(callback).toBeDefined();
		const agents = [
			{
				id: 'claude',
				toolType: 'claude-code',
				customEnvVars: { CLAUDE_CONFIG_DIR: '/isolated/claude' },
			},
			{ id: 'codex', toolType: 'codex', customEnvVars: { CODEX_HOME: '/isolated/codex' } },
			{
				id: 'disabled',
				toolType: 'codex',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'off' },
			},
			{
				id: 'missing',
				toolType: 'codex',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'gone' },
			},
			{
				id: 'remote',
				toolType: 'claude-code',
				customEnvVars: { CLAUDE_CONFIG_DIR: '/isolated/remote-claude' },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'on' },
			},
		];
		const enabledRemote = { enabled: true };
		const listSessions = vi.fn(async () => [{ sessionId: 'owned' }, { sessionId: 'ordinary-cli' }]);
		const markRelaySession = vi.fn();
		const isOwned = vi.fn(
			(plugin: string, _agent: string, session: string) =>
				plugin === RELAY_PLUGIN_ID && session === 'owned'
		);
		const js = ts.transpileModule(`const backfill = ${callback!.getText(sf)}`, {
			compilerOptions: { target: ts.ScriptTarget.ES2024 },
		}).outputText;
		const backfill = new Function(
			'sessionsStore',
			'getSessionStorage',
			'getSshRemoteById',
			'relayProjectPath',
			'getProviderProfileConfig',
			'pluginProviderSessions',
			'markRelaySession',
			'logger',
			'RELAY_PLUGIN_ID',
			`${js}\nreturn backfill;`
		)(
			{ get: () => agents },
			() => ({ listSessions }),
			(id: string) => (id === 'on' ? enabledRemote : id === 'off' ? { enabled: false } : undefined),
			() => '/isolated/project',
			getProviderProfileConfig,
			{ isOwned },
			markRelaySession,
			{ warn: vi.fn() },
			RELAY_PLUGIN_ID
		);
		await backfill();
		expect(listSessions.mock.calls).toEqual([
			['/isolated/project', undefined, '/isolated/claude'],
			['/isolated/project', undefined, '/isolated/codex'],
			['/isolated/project', enabledRemote, '/isolated/remote-claude'],
		]);
		expect(markRelaySession.mock.calls).toEqual([
			[agents[0], 'owned', true],
			[agents[1], 'owned', true],
			[agents[4], 'owned', true],
		]);
	});
});

describe('production net:connect wiring (persistent socket sink)', () => {
	const keys = depsObjectKeys();
	const handlerSource = fs.readFileSync(
		path.join(__dirname, '../../../main/plugins/plugin-host-handlers.ts'),
		'utf-8'
	);

	it('wires netConnect / netSend / netClose TOGETHER (never a partial surface)', () => {
		// A partial surface (e.g. connect without close) would leak sockets or make
		// live-revoke unenforceable - either is a security review, not a refactor.
		const wired = keys.filter((k) => k === 'netConnect' || k === 'netSend' || k === 'netClose');
		// Either all three are wired, or none are (the inert Phase-1 state).
		expect(wired.length === 0 || wired.length === 3).toBe(true);
		if (wired.length > 0) {
			expect(keys).toContain('netConnect');
			expect(keys).toContain('netSend');
			expect(keys).toContain('netClose');
		}
	});

	it('the net.connect handler enforces wss:-only and a trusted signed plugin', () => {
		// Pin the two gates that make a persistent egress channel acceptable. These
		// live in the handler factory; weakening either must fail the build.
		expect(handlerSource).toMatch(/only wss/);
		expect(handlerSource).toMatch(/net\.connect requires a trusted signed plugin/);
		// The per-plugin cap and per-frame cap constants must exist.
		expect(handlerSource).toMatch(/MAX_SOCKETS_PER_PLUGIN\s*=\s*4/);
		expect(handlerSource).toMatch(/MAX_FRAME_BYTES\s*=\s*64 \* 1024/);
	});

	it('the socket sink pins the connect to the egress-guard lookup and caps frames', () => {
		// The raw ws must resolve through the SSRF/DNS-rebind classifier, identical
		// to net.fetch, and cap inbound frame size.
		expect(source).toMatch(/https\.Agent\(\{[\s\S]*?lookup: pluginEgressGuard\.lookup/);
		expect(source).toMatch(/maxPayload:/);
	});
});

describe('production session-grant wiring (host-held per-session access)', () => {
	const keys = depsObjectKeys();

	it('wires the grant-set predicates TOGETHER with the writer and the host-owned confirmation', () => {
		// These four are a unit. `grantSession` wired without `usesSessionGrants`
		// would let the writer run for a plugin that never asked to be governed by
		// a grant set; without `isSessionGranted` the dispatch and History gates
		// both fail open-ish (the handler's `?.() !== true` denies, so the verbs
		// would simply be dead); without `confirmSessionAccess` the only way into
		// the set is self-creation, silently dropping user approval. Pin the set so
		// removing any one of them fails the build and forces a security review.
		for (const key of [
			'usesSessionGrants',
			'isSessionGranted',
			'grantSession',
			'confirmSessionAccess',
		]) {
			expect(keys).toContain(key);
		}
		// The confirmation names the plugin, so the human sees a name rather than
		// an opaque id when deciding.
		expect(keys).toContain('pluginDisplayName');
	});

	it('grants ONLY the session the plugin just created, and only for a granting plugin', () => {
		// Exactly one `grantSession(...)` call may exist in the production host, it
		// must be the created-session grant, and it must sit behind
		// `usesSessionGrants`. A second call site would be a new way into the set
		// that bypasses both self-creation and the user's confirmation.
		let calls = 0;
		let guarded: string | null = null;
		const visit = (node: ts.Node): void => {
			if (
				ts.isCallExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === 'grantSession'
			) {
				calls += 1;
			}
			if (
				ts.isIfStatement(node) &&
				node.expression.getText(sf) === 'usesSessionGrants(pluginId)' &&
				node.thenStatement.getText(sf).includes('grantSession(')
			) {
				guarded = node.thenStatement.getText(sf);
			}
			ts.forEachChild(node, visit);
		};
		visit(sf);
		expect(calls).toBe(1);
		// The source recorded is 'created' (never 'user-approved', which only the
		// host-owned confirmation may claim), and the id granted is the session the
		// store just wrote - not anything read out of the plugin's params.
		expect(guarded).toMatch(/grantSession\(pluginId, sessionId, 'created'\)/);
		// The host-verified pluginId reaches the create sink as its own argument,
		// so a forged `pluginId` in the params cannot become a self-grant.
		expect(source).toMatch(
			/const pluginSessionsCreate = async \(\s*params: Record<string, unknown>,\s*pluginId: string/
		);
	});

	it('refuses a plugin-supplied id that already exists, BEFORE the created-grant', () => {
		// `sessions.create` takes the id from the plugin's own params. Without this
		// rejection, naming a LIVE agent appended a second record under its id and
		// then fell through to `grantSession(..., 'created')`, handing the plugin
		// dispatch and History reach over an agent it never created and the user
		// never approved - the exact thing the grant set exists to prevent.
		// Pinned on the source because the escalation is an ORDERING property: the
		// check is worthless if it lands after the store write or the grant.
		const rejection = source.indexOf('sessions.create never adopts an existing session');
		expect(rejection).toBeGreaterThan(-1);
		// It throws, rather than quietly generating a fresh id (which would make a
		// create silently target a different agent than the plugin asked for).
		expect(source).toMatch(
			/if \(requestedId !== undefined && pluginSessionsRaw\(\)\.some\(\(s\) => s\.id === requestedId\)\) \{\s*throw new Error\(/
		);
		// ...and it precedes both the store write and the grant.
		const storeWrite = source.indexOf('setPluginSessionsRaw([...previousSessions, session])');
		const grant = source.indexOf("grantSession(pluginId, sessionId, 'created')");
		expect(storeWrite).toBeGreaterThan(rejection);
		expect(grant).toBeGreaterThan(rejection);
	});

	it("the host-owned confirmation defaults to Don't Allow and grants only on Allow", async () => {
		// Extract the PRODUCTION confirmation and run it, rather than regexing its
		// text: this proves the default button, the Escape path, and the
		// response-to-boolean mapping, which is where a quiet "defaultId: 1" edit
		// would turn a deliberate approval into a reflex one.
		let callback: ts.ArrowFunction | undefined;
		const visit = (node: ts.Node): void => {
			if (
				ts.isPropertyAssignment(node) &&
				node.name.getText(sf) === 'confirmSessionAccess' &&
				ts.isArrowFunction(node.initializer)
			) {
				callback = node.initializer;
			}
			ts.forEachChild(node, visit);
		};
		visit(sf);
		expect(callback, 'confirmSessionAccess not found in index.ts').toBeDefined();

		const js = ts.transpileModule(`const confirm = ${callback!.getText(sf)}`, {
			compilerOptions: { target: ts.ScriptTarget.ES2024 },
		}).outputText;
		const shown: Array<Record<string, unknown>> = [];
		const parented: boolean[] = [];
		const build = (response: number, windowAlive: boolean) =>
			new Function('mainWindow', 'dialog', `${js}\nreturn confirm;`)(
				windowAlive ? { isDestroyed: () => false } : { isDestroyed: () => true },
				{
					showMessageBox: async (a: unknown, b?: unknown) => {
						shown.push((b ?? a) as Record<string, unknown>);
						parented.push(b !== undefined);
						return { response };
					},
				}
			) as (info: Record<string, unknown>) => Promise<boolean>;

		const info = {
			pluginId: 'maestro-kanban',
			pluginName: 'Kanban Board',
			sessionId: 'sess-2',
			sessionTitle: 'Other agent',
			projectPath: '/projects/other',
		};
		// Button 0 is both the default and the cancel (Escape) answer, and it does
		// NOT grant. Button 1 is the only answer that does.
		await expect(build(0, true)(info)).resolves.toBe(false);
		await expect(build(1, true)(info)).resolves.toBe(true);
		// Any other response (a closed dialog on some platforms) is not a grant.
		await expect(build(-1, true)(info)).resolves.toBe(false);

		const options = shown[0]!;
		expect(options.buttons).toEqual(["Don't Allow", 'Allow']);
		expect(options.defaultId).toBe(0);
		expect(options.cancelId).toBe(0);
		// The text has to name the plugin, the agent, and both powers being
		// granted, so the human is not approving a blank cheque.
		expect(options.message).toContain('Kanban Board');
		expect(options.message).toContain('Other agent');
		expect(String(options.detail)).toMatch(/send messages to this agent and read its History/);
		expect(String(options.detail)).toMatch(/does not give access to any other agent/);
		expect(String(options.detail)).toContain('/projects/other');
		// Parented to the main window when one is alive, and still shown (never
		// silently skipped, which would deny access with no explanation) when not.
		expect(parented).toEqual([true, true, true]);
		shown.length = 0;
		parented.length = 0;
		await expect(build(1, false)(info)).resolves.toBe(true);
		expect(parented).toEqual([false]);
	});

	it('forwards the tab target into the dispatch sink', () => {
		// `tabId` narrows where a dispatched prompt lands. A sink that dropped it
		// would silently widen every tab-targeted send back to the active tab.
		expect(source).toMatch(
			/dispatch: async \(agentId, prompt, tabId\) =>\s*dispatchPromptToSession\(agentId, prompt, tabId\)/
		);
	});

	it('installs the grant set over the sealed ledger, keyed on a LIVE session check', () => {
		let installed: ts.ObjectLiteralExpression | undefined;
		const visit = (node: ts.Node): void => {
			if (
				!installed &&
				ts.isCallExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === 'configurePluginSessionGrants'
			) {
				const arg = node.arguments[0];
				if (arg && ts.isObjectLiteralExpression(arg)) installed = arg;
			}
			ts.forEachChild(node, visit);
		};
		visit(sf);
		expect(installed, 'configurePluginSessionGrants({...}) not found in index.ts').toBeDefined();
		const text = installed!.getText(sf);
		// The sealed authorization ledger owns the member set: no separate store,
		// so a grant is sealed, epoch-bumped, broker-checked, and revocable in
		// Settings for free.
		expect(text).toMatch(/authStore,/);
		// The keyword is read off the MANIFEST, never the ledger (the host rewrites
		// the ledger scope to real ids as it grants).
		expect(text).toMatch(
			/getRequestedPermissions: \(pluginId\) => pluginManager\?\.getRequestedPermissions\(pluginId\)/
		);
		// Only a live session id may be granted, checked against the session store
		// at grant time: this is what stops an agent NAME from entering the set.
		expect(text).toMatch(/sessionExists: \(sessionId\) =>/);
		expect(text).toMatch(/sessionsStore\.get\('sessions', \[\]\)/);
		// Every grant and revoke is audited.
		expect(text).toMatch(/audit: \(message\) =>/);
	});
});
