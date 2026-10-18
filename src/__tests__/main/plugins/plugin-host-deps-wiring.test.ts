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
