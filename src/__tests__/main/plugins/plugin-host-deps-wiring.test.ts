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
 *    wired alongside `spawn` — never one without the other);
 *  - the registry construction ships EMPTY in production (only the DEMO_MODE
 *    e2e blessing exists, env-gated);
 *  - `execFile` is used with `shell: false` (never a shell).
 *
 * Keys are read from the parsed AST (not a regex/paren scan) so strings,
 * comments, or unrelated identifiers elsewhere can't affect it.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

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

describe('production host-handler deps wiring (FC2 — wired and gated)', () => {
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
		// gate — this pins it so doing so fails the build and forces a review.
		if (keys.includes('dispatch')) {
			expect(keys).toContain('dispatchUnattendedAllowed');
		}
	});

	it('still wires the safe read-only deps (guard targets the right call)', () => {
		expect(keys).toContain('listAgents');
		expect(keys).toContain('broker');
	});

	it('production blesses NO spawn binaries — the only register() site is the env-gated DEMO blessing', () => {
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

describe('production net:connect wiring (persistent socket sink)', () => {
	const keys = depsObjectKeys();
	const handlerSource = fs.readFileSync(
		path.join(__dirname, '../../../main/plugins/plugin-host-handlers.ts'),
		'utf-8'
	);

	it('wires netConnect / netSend / netClose TOGETHER (never a partial surface)', () => {
		// A partial surface (e.g. connect without close) would leak sockets or make
		// live-revoke unenforceable — either is a security review, not a refactor.
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
