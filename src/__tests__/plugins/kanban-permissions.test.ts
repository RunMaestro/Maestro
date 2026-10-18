/**
 * @file kanban-permissions.test.ts
 * @description Audits the shipped `examples/plugins/maestro-kanban/plugin.json`
 * permission set against what `main.js` actually calls, and pins the three
 * confinement properties the Kanban board's safety story rests on: no network
 * egress beside `transcripts:read`, session-scoped reach for the two verbs that
 * act on one agent, and filesystem reach that cannot leave `~/.maestro/kanban*`.
 *
 * Every capability in the manifest is shown to the user at consent, so one the
 * code never exercises is a permission the user grants for nothing. The audit
 * below is structural rather than a hand-maintained list: it parses `main.js`
 * with the TypeScript compiler's own JS parser, collects the host methods it
 * really calls (an AST walk sees no comments and no strings, which a grep does
 * - the API names appear in both), maps them through the host's
 * `HOST_METHOD_CAPABILITY` table, and compares that to the manifest both ways.
 * Adding an unused capability fails, and so does calling a method the manifest
 * does not cover.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { validatePluginManifest, type PluginManifest } from '../../shared/plugins/plugin-manifest';
import { collectContributions } from '../../shared/plugins/contributions';
import { GRANTED_SESSIONS_SCOPE, type PluginCapability } from '../../shared/plugins/permissions';
import {
	EGRESS_CAPABILITIES,
	transcriptReadEgressConflict,
} from '../../shared/plugins/capability-policy';
import { HOST_METHOD_CAPABILITY, isHostMethod } from '../../shared/plugins/rpc-protocol';

const require = createRequire(import.meta.url);
const manifestPath = require.resolve('../../../examples/plugins/maestro-kanban/plugin.json');
const mainPath = require.resolve('../../../examples/plugins/maestro-kanban/main.js');

interface KanbanPathHelpers {
	projectBoardSlug: (projectPath: string) => string;
	planFileRelativePath: (planId: string) => string;
}

/** The shipped manifest, through the host's own validator. */
function loadManifest(): PluginManifest {
	const result = validatePluginManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
	if (!result.manifest) throw new Error(`manifest invalid: ${result.errors.join('; ')}`);
	expect(result.errors).toEqual([]);
	return result.manifest;
}

/**
 * Every `maestro.<ns>.<method>()` / `sdk.<ns>.<method>()` call in `main.js`,
 * found by walking the parsed AST. `sdk` is the module-level handle `activate()`
 * assigns the SDK to and `maestro` is that same object's parameter name, so the
 * two spellings are one call surface. Parsing rather than grepping matters here:
 * `main.js` names these methods in its own comments (`maestro.tabs.list()`,
 * `maestro.sessions.create({...})`), and a text scan counts those as calls while
 * missing a real call whose receiver and method sit on different lines.
 */
function hostMethodsCalledByMain(): Set<string> {
	const source = ts.createSourceFile(
		'main.js',
		readFileSync(mainPath, 'utf8'),
		ts.ScriptTarget.ES2020,
		true,
		ts.ScriptKind.JS
	);
	const methods = new Set<string>();
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			if (
				ts.isPropertyAccessExpression(callee) &&
				ts.isPropertyAccessExpression(callee.expression) &&
				ts.isIdentifier(callee.expression.expression)
			) {
				const root = callee.expression.expression.text;
				if (root === 'maestro' || root === 'sdk') {
					methods.add(`${callee.expression.name.text}.${callee.name.text}`);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return methods;
}

/**
 * The capabilities `main.js` actually needs, from the host's own
 * method->capability table. `commands.register` and `events.on` are SDK-local
 * registration helpers rather than brokered host methods, so they map to no
 * capability and are filtered out by `isHostMethod`.
 */
function capabilitiesExercisedByCode(): Set<PluginCapability> {
	const capabilities = new Set<PluginCapability>();
	for (const method of hostMethodsCalledByMain()) {
		if (isHostMethod(method)) capabilities.add(HOST_METHOD_CAPABILITY[method]);
	}
	return capabilities;
}

/**
 * Capabilities a manifest needs for its CONTRIBUTIONS rather than for a call:
 * `gateContributions` drops `panels` without `ui:panel` and `uiItems` without
 * `ui:contribute`, so holding these is load-bearing even though no RPC names
 * them. `commands` and `keybindings` are gated by neither. Read through
 * `collectContributions` so this sees the same parsed shape the host does.
 */
function capabilitiesRequiredByContributions(manifest: PluginManifest): Set<PluginCapability> {
	const capabilities = new Set<PluginCapability>();
	const contributes = collectContributions(manifest);
	if (contributes.panels.length > 0) capabilities.add('ui:panel');
	if (contributes.uiItems.length > 0) capabilities.add('ui:contribute');
	return capabilities;
}

function sortedCapabilities(values: Iterable<PluginCapability>): PluginCapability[] {
	return [...new Set(values)].sort();
}

describe('maestro-kanban permission audit', () => {
	it('requests no capability the plugin never uses', () => {
		const manifest = loadManifest();
		const needed = new Set<PluginCapability>([
			...capabilitiesExercisedByCode(),
			...capabilitiesRequiredByContributions(manifest),
		]);
		const requested = sortedCapabilities(
			(manifest.permissions ?? []).map((permission) => permission.capability)
		);
		// Guard against a vacuous pass: a parse that found nothing would make
		// every capability look unused and this assertion would still "fail
		// open" into an empty diff if `requested` were also empty.
		expect(requested.length).toBeGreaterThan(10);
		const unused = requested.filter((capability) => !needed.has(capability));
		expect(unused).toEqual([]);
	});

	it('requests every capability the plugin does use', () => {
		const manifest = loadManifest();
		const requested = new Set(
			(manifest.permissions ?? []).map((permission) => permission.capability)
		);
		const needed = sortedCapabilities([
			...capabilitiesExercisedByCode(),
			...capabilitiesRequiredByContributions(manifest),
		]);
		expect(needed.length).toBeGreaterThan(10);
		const missing = needed.filter((capability) => !requested.has(capability));
		expect(missing).toEqual([]);
	});

	it('holds transcripts:read and therefore no egress capability', () => {
		const manifest = loadManifest();
		const permissions = manifest.permissions ?? [];
		const held = permissions.map((permission) => permission.capability);
		expect(held).toContain('transcripts:read');
		// The exclusion is only interesting while the plugin reads transcripts,
		// which the assertion above pins. `EGRESS_CAPABILITIES` is read from the
		// host rather than retyped, so a new egress capability is covered the
		// day it is added.
		const egressHeld = held.filter((capability) => EGRESS_CAPABILITIES.includes(capability));
		expect(egressHeld).toEqual([]);
		// The same rule the consent dialog and the call-time broker apply, asked
		// for the UNTRUSTED case: a throwaway-signed or unsigned install must
		// still be allowed to run, so the combination has to be clean outright
		// and not merely clean once a trusted key is in place.
		expect(transcriptReadEgressConflict(permissions, { trusted: false })).toBeNull();
	});

	it('scopes agents:dispatch and transcripts:read to granted sessions, and nothing else', () => {
		const permissions = loadManifest().permissions ?? [];
		const sessionScoped = permissions
			.filter((permission) => permission.scope === GRANTED_SESSIONS_SCOPE)
			.map((permission) => permission.capability)
			.sort();
		expect(sessionScoped).toEqual(['agents:dispatch', 'transcripts:read']);
		// Both directions: the keyword appears on exactly those two, and those
		// two carry nothing but the keyword (an unscoped `agents:dispatch` is the
		// wildcard form the host forbids, and a path-scoped `transcripts:read`
		// would reach every session under that path).
		for (const capability of ['agents:dispatch', 'transcripts:read'] as const) {
			const scopes = permissions
				.filter((permission) => permission.capability === capability)
				.map((permission) => permission.scope);
			expect(scopes).toEqual([GRANTED_SESSIONS_SCOPE]);
		}
	});

	it('scopes fs:read and fs:write to exactly the four ~/.maestro/kanban* locations', () => {
		const permissions = loadManifest().permissions ?? [];
		const expected = [
			'~/.maestro/kanban-archive',
			'~/.maestro/kanban-boards',
			'~/.maestro/kanban-conductor',
			'~/.maestro/kanban.yaml',
		];
		for (const capability of ['fs:read', 'fs:write'] as const) {
			const scopes = permissions
				.filter((permission) => permission.capability === capability)
				.map((permission) => permission.scope)
				.sort();
			expect(scopes).toEqual(expected);
		}
		// `fs:watch` would be a fifth filesystem verb with its own scope list;
		// the plugin holds none, so there is nothing else to keep in step.
		expect(permissions.some((permission) => permission.capability === 'fs:watch')).toBe(false);
	});

	it('names no filesystem location outside those four anywhere in main.js', () => {
		// Every path the plugin can build is rooted in a `~`-prefixed string
		// literal (the host expands `~` and confines it to `~/.maestro/`; the
		// plugin never resolves one itself). So the set of `~` literals in the
		// source IS the set of roots it can reach, and pinning it here means a
		// new one cannot slip past the manifest's scopes unnoticed.
		const source = ts.createSourceFile(
			'main.js',
			readFileSync(mainPath, 'utf8'),
			ts.ScriptTarget.ES2020,
			true,
			ts.ScriptKind.JS
		);
		const roots = new Set<string>();
		const visit = (node: ts.Node): void => {
			if (
				(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
				node.text.startsWith('~')
			) {
				roots.add(node.text);
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
		expect([...roots].sort()).toEqual([
			'~/.maestro/kanban-archive',
			'~/.maestro/kanban-boards',
			'~/.maestro/kanban-conductor',
			'~/.maestro/kanban.yaml',
		]);
	});

	it('cannot escape those roots through a board slug or a plan id', () => {
		const plugin = require(mainPath) as KanbanPathHelpers;
		// Every board, archive and conductor path below the four roots is named
		// by `projectBoardSlug()`, so a project path a user chose is the one
		// attacker-influenced input in a filesystem path. It is sanitized to
		// `[a-z0-9-]` plus a hash of the full path, which has no `.`, `/` or `\`
		// and therefore cannot traverse.
		for (const projectPath of [
			'../../etc/passwd',
			'/Users/someone/..%2f..%2froot',
			'C:\\Windows\\System32',
			'/tmp/../../..',
			'',
		]) {
			expect(plugin.projectBoardSlug(projectPath)).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/);
		}
		// A plan file is the other name the plugin appends, and it only accepts
		// an id of its own shape rather than sanitizing a bad one into silence.
		expect(plugin.planFileRelativePath('plan-20260101-abc')).toBe('plans/plan-20260101-abc.json');
		for (const planId of ['../escape', 'plans/../../x', 'Plan-Upper', '']) {
			expect(() => plugin.planFileRelativePath(planId)).toThrow();
		}
	});
});
