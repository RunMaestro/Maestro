/**
 * @file plugin-host-deps-wiring.test.ts
 * @description Production-site security guard (E-InertCaps). The handler factory
 * contract is covered in plugin-host-handlers.test.ts; this locks the ONE
 * integration site that decides whether the arbitrary-code-execution-grade verbs
 * are reachable in the shipped app: the live `buildHostCallHandlers({...})` call
 * in src/main/index.ts must NOT pass the optional `dispatch` / `spawn` deps.
 *
 * Wiring `dispatch` enables `agents.dispatch` (a plugin makes an agent run code);
 * wiring `spawn` enables `process.spawn` (a plugin runs a shell command). Both are
 * deferred until the Phase-3 OS sandbox — a confined cwd + minimal-env
 * child_process is NOT a sandbox. If someone wires either dep here, this test
 * fails and forces a security review instead of a silent regression.
 *
 * The keys are read from the parsed AST (not a regex/paren scan) so strings,
 * comments, or unrelated `dispatch`/`spawn` identifiers elsewhere can't affect it.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/** Parse index.ts and return the property names of the object literal passed to
 * the live `buildHostCallHandlers({ ... })` call. */
function depsObjectKeys(source: string): string[] {
	const sf = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
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

describe('production host-handler deps wiring (E-InertCaps)', () => {
	const indexPath = path.join(__dirname, '../../../main/index.ts');
	const keys = depsObjectKeys(fs.readFileSync(indexPath, 'utf-8'));

	it('does NOT pass a `dispatch` dep — agents.dispatch stays inert', () => {
		expect(keys).not.toContain('dispatch');
	});

	it('does NOT pass a `spawn` dep — process.spawn stays inert', () => {
		expect(keys).not.toContain('spawn');
	});

	it('still wires the safe read-only deps (guard targets the right call)', () => {
		// Sanity: prove we located the real deps object, not an empty/missing one.
		expect(keys).toContain('listAgents');
		expect(keys).toContain('broker');
	});
});
