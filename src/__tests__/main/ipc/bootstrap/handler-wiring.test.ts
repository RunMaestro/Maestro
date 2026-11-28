/**
 * Wiring parity between the two IPC registration lists (MAESTRO-YV).
 *
 * `src/main/ipc/handlers/index.ts` exports `registerAllHandlers()`, which reads
 * like the authoritative registration list but is dead: nothing calls it. The
 * live path is `setupIpcHandlers()` in `src/main/ipc/bootstrap/index.ts`, which
 * `main/index.ts` invokes at app-ready.
 *
 * The Context Timeline handlers were added to the dead list only, so
 * `contextTimeline:getCaptures` / `contextTimeline:clearCaptures` were never
 * registered in a shipped build. The renderer fires `clearCaptures` as a
 * floating promise, so it surfaced as an unhandled rejection
 * ("No handler registered for 'contextTimeline:clearCaptures'") and the panel
 * silently hydrated empty on every reload.
 *
 * The per-handler unit test could not catch this: it calls
 * `registerContextTimelineHandlers()` directly, so it stayed green while
 * production was broken. This test reads the two sources instead and asserts
 * the invariant that actually held wrong - a registrar in the dead list must
 * also be invoked by the live one.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SRC = path.resolve(__dirname, '../../../../main/ipc');
const HANDLERS_INDEX = path.join(SRC, 'handlers/index.ts');
const BOOTSTRAP_INDEX = path.join(SRC, 'bootstrap/index.ts');

const REPO_ROOT = path.resolve(SRC, '../../..');

/**
 * Optional dependencies of a registrar that the live wiring leaves out on
 * purpose, keyed `registrar.dependency`. Each one is a test seam whose handler
 * runs the real implementation when it is absent. Anything else the live
 * wiring drops is a feature quietly turned off in a shipped build.
 */
const INTENTIONALLY_OMITTED: Record<string, string> = {
	'registerPersistenceHandlers.cancelQueueItem':
		'test seam; absent, the handler cancels through cancelPianolaQueueItem() on the live store',
	'registerPianolaHandlers.confirmScopeConfiguration':
		'test seam; absent, the handler raises the native approval dialog',
};

/**
 * For every `register*Handlers(...)` call in `file`, the optional properties of
 * the parameter's type that the call does not pass, as `registrar.dependency`.
 * Uses the type checker, so spreads (`...deps.debugPackageDeps`) and shorthand
 * properties count the same as written-out keys.
 */
function droppedOptionalDependencies(file: string): string[] {
	const configPath = path.join(REPO_ROOT, 'tsconfig.main.json');
	const config = ts.getParsedCommandLineOfConfigFile(
		configPath,
		{},
		{ ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined }
	);
	if (!config) throw new Error(`Could not read ${configPath}`);
	const program = ts.createProgram({ rootNames: [file], options: config.options });
	const checker = program.getTypeChecker();
	const source = program.getSourceFile(file);
	if (!source) throw new Error(`Could not load ${file}`);
	const dropped: string[] = [];
	let calls = 0;
	const visit = (node: ts.Node) => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			/^register[A-Za-z]+Handlers$/.test(node.expression.text)
		) {
			calls++;
			const registrar = node.expression.text;
			const signature = checker.getResolvedSignature(node);
			signature?.parameters.forEach((parameter, index) => {
				const optional = checker
					.getTypeOfSymbolAtLocation(parameter, node)
					.getApparentProperties()
					.filter((property) => property.flags & ts.SymbolFlags.Optional)
					.map((property) => property.name);
				const argument = node.arguments[index];
				const given = new Set(
					argument
						? checker
								.getTypeAtLocation(argument)
								.getProperties()
								.map((property) => property.name)
						: []
				);
				for (const name of optional) {
					if (!given.has(name)) dropped.push(`${registrar}.${name}`);
				}
			});
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	// A checker that silently resolved nothing would report no drops at all.
	expect(calls).toBeGreaterThan(30);
	return dropped.sort();
}

/** Strip line and block comments so prose cannot be mistaken for a call. */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
}

/**
 * Registrar names that are *invoked* in a file. Requiring the open paren keeps
 * import/export list entries (`registerFooHandlers,` / `export { ... };`) out,
 * and matching anywhere on the line keeps assignment-form calls
 * (`const h = registerPersistenceHandlers({...})`) in.
 *
 * Comments are stripped first and declarations are excluded, because both look
 * exactly like calls to a regex. Without that this test passes for the wrong
 * reason: `registerAllHandlers(` matches its own `function` declaration in the
 * handlers file, and a comment in the bootstrap file mentioning
 * `registerAllHandlers()` matches there, so the two cancel out. Editing that
 * comment would then fail the test, and a registrar-shaped comment could hide a
 * genuinely missing live registration.
 */
function invokedRegistrars(filePath: string): Set<string> {
	const source = stripComments(readFileSync(filePath, 'utf-8'));
	const names = source.match(/(?<!function\s)register[A-Za-z]+Handlers\(/g) ?? [];
	return new Set(names.map((n) => n.slice(0, -1)));
}

describe('IPC handler wiring parity', () => {
	it('registers every handler from the dead registerAllHandlers list in the live setupIpcHandlers', () => {
		// The wrapper is the dead list itself, not a member of it. Nothing is
		// expected to call it - that is the whole premise of this test.
		const dead = invokedRegistrars(HANDLERS_INDEX);
		dead.delete('registerAllHandlers');
		const live = invokedRegistrars(BOOTSTRAP_INDEX);

		// Sanity: the extraction found a realistic number of registrars, so a
		// regex that silently stops matching fails loudly instead of passing.
		expect(dead.size).toBeGreaterThan(30);
		expect(live.size).toBeGreaterThan(30);

		const missing = [...dead].filter((name) => !live.has(name)).sort();
		expect(missing).toEqual([]);
	});

	it('hands the live History and Federation handlers the Cue queries, so Cue runs reach every History panel', () => {
		// Cue runs live in `cue_events`, never in the JSONL History. Without these the History
		// panel of every agent (local, SSH, or hosted) lists no Cue run at all.
		const source = stripComments(readFileSync(BOOTSTRAP_INDEX, 'utf8'));
		const call = (name: string) => {
			const start = source.indexOf(`${name}({`);
			expect(start).toBeGreaterThan(-1);
			return source.slice(start, source.indexOf('});', start));
		};
		const history = call('registerHistoryHandlers');
		for (const query of [
			'getAllSessions',
			'getCueHistoryEntries',
			'getCueHistoryGroups',
			'getCueHistoryGroupRuns',
			'getCueHistoryBuckets',
			'getCueHistoryFingerprint',
		]) {
			expect(history).toContain(query);
		}
		const federation = call('registerFederationHandlers');
		expect(federation).toContain('getCueHistoryEntries');
		expect(federation).toContain('getCueHistoryGroups');
	});

	it('passes every optional dependency a registrar declares, except the named test seams', () => {
		// Director's Notes was registered without its Cue queries, so it reported
		// zero Cue activity in every shipped build; Feedback was registered without
		// the maestro-cli manager. Both compiled, because the dependencies are
		// optional. This reads the parameter types, so the next dropped one fails.
		expect(droppedOptionalDependencies(BOOTSTRAP_INDEX)).toEqual(
			Object.keys(INTENTIONALLY_OMITTED).sort()
		);
	}, 120_000);

	it("hands the live Director's Notes handlers the Cue queries", () => {
		const source = stripComments(readFileSync(BOOTSTRAP_INDEX, 'utf8'));
		const start = source.indexOf('registerDirectorNotesHandlers({');
		expect(start).toBeGreaterThan(-1);
		const call = source.slice(start, source.indexOf('});', start));
		for (const query of [
			'getCueHistoryEntries',
			'getCueHistoryBuckets',
			'getCueHistoryFingerprint',
		]) {
			expect(call).toContain(query);
		}
	});

	it('uses the composed post-flush Pianola consumer in the live bootstrap', () => {
		const source = stripComments(readFileSync(BOOTSTRAP_INDEX, 'utf8'));
		// Parity R17: wrapped so a Move Back drops its host outage at once (`withHostedAgentsNote()`).
		expect(source).toMatch(
			/onSessionsPersisted: withHostedAgentsNote\(\s*pianolaPersistenceConsumer\(deps\.getPianolaSupervisor\),\s*noteHostedAgentsChanged\s*\)/
		);
		expect(source).toContain("from './pianola-persistence'");
		expect(source).toContain("from './sessions-persisted'");
	});

	it('registers the same plugin create/delete implementation as the adapter composition', () => {
		const source = stripComments(readFileSync(path.resolve(SRC, '../index.ts'), 'utf8'));
		expect(source).toContain("from './plugins/plugin-session-lifecycle'");
		expect(source).toMatch(
			/create: pluginSessionsCreate, remove: pluginSessionsDelete[\s\S]*?createPluginSessionLifecycle\(/
		);
		expect(source).toContain('flush: flushPendingSessionWrites');
		expect(source).toContain('sessionsCreate: pluginSessionsCreate');
		expect(source).toContain('sessionsDelete: pluginSessionsDelete');
	});

	it('wires the Context Timeline handlers into the live bootstrap path', () => {
		expect(invokedRegistrars(BOOTSTRAP_INDEX)).toContain('registerContextTimelineHandlers');
	});
});
