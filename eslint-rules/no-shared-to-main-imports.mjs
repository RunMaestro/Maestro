/**
 * ESLint rules: process import boundaries.
 *
 * `no-shared-to-main-imports`: `src/shared/**` is compiled by BOTH
 * `tsconfig.main.json` and `tsconfig.renderer.json`, so a shared file that
 * imports from `src/main/**` pulls main-process-only code (fs, child_process,
 * electron-store, ...) into the renderer's TypeScript program, and makes
 * maestro-lib (which lives under `src/shared/maestro-lib/`) depend on the
 * desktop it is meant to run without.
 *
 * There are no exceptions. maestro-lib Part One arrived with 13 such edges;
 * they were retired by moving plain Node code into the library and routing
 * the few genuinely host-owned services (logging, crash reporting, capability
 * snapshots, the image store) through `src/shared/maestro-lib/host.ts`, which
 * the desktop registers into. A new need goes through that seam, not an
 * import.
 *
 * `no-main-to-renderer-imports`: `src/main/**` is compiled by `tsc` into
 * `dist/main`, and any renderer file it imports is emitted beside it under
 * `dist/renderer`. The renderer build (Vite, `emptyOutDir`) then wipes
 * `dist/renderer`, so the import works in `npm run dev` and fails only in a
 * packaged app. On 2026-11-12 the 1.1.1-RC build opened no window at all:
 * `ClaudeSdkSpawner` imported a renderer helper, and `ProcessManager` (which
 * imports it) could not load. Code both sides need lives in `src/shared`.
 *
 * Scope: relative imports only. A bare specifier (an npm package) can never
 * resolve into `src/`, so it is out of scope by construction.
 */

import path from 'node:path';

function toPosix(value) {
	return value.split(path.sep).join('/');
}

/**
 * Build a rule that forbids files under `src/<from>/` from importing anything
 * under `src/<to>/` by a relative specifier.
 */
function createBoundaryRule({ from, to, description, message }) {
	const rootMarker = `src/${from}/`;
	const forbiddenRoot = `src/${to}`;

	function resolvesUnderForbiddenRoot(fromFilePosix, specifier) {
		const resolved = path.posix
			.normalize(path.posix.join(path.posix.dirname(fromFilePosix), specifier))
			.replace(/^\.\.(\/|$)/, ''); // defensive; normalize shouldn't leave a leading .. here
		return resolved === forbiddenRoot || resolved.startsWith(`${forbiddenRoot}/`);
	}

	/** @type {import('eslint').Rule.RuleModule} */
	const rule = {
		meta: {
			type: 'problem',
			docs: { description },
			schema: [],
			messages: { newEdge: message },
		},
		create(context) {
			const filename = toPosix(context.filename ?? context.getFilename());
			const rootIndex = filename.indexOf(rootMarker);
			if (rootIndex === -1) {
				return {};
			}
			const relativeToRoot = filename.slice(rootIndex + rootMarker.length);
			const fromFilePosix = filename.slice(rootIndex); // starts at "src/<from>/..."

			function checkSpecifier(reportNode, specifier) {
				if (typeof specifier !== 'string' || !specifier.startsWith('.')) {
					return;
				}
				if (!resolvesUnderForbiddenRoot(fromFilePosix, specifier)) {
					return;
				}
				context.report({
					node: reportNode,
					messageId: 'newEdge',
					data: { from: relativeToRoot, specifier },
				});
			}

			return {
				ImportDeclaration(node) {
					checkSpecifier(node.source, node.source.value);
				},
				// `export * from '../../../main/x'` and `export { y } from '...'` are
				// dependencies too, and re-exporting is how a shim is normally written,
				// so leaving them unvisited left the widest hole in the rule.
				ExportAllDeclaration(node) {
					// `export *` has no sourceless form, so `source` is always set here.
					checkSpecifier(node.source, node.source.value);
				},
				ExportNamedDeclaration(node) {
					// Null for a local `export { y }` / `export const y`, which names
					// nothing outside this file.
					if (node.source) {
						checkSpecifier(node.source, node.source.value);
					}
				},
				ImportExpression(node) {
					if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
						checkSpecifier(node.source, node.source.value);
					}
				},
				CallExpression(node) {
					if (
						node.callee.type === 'Identifier' &&
						node.callee.name === 'require' &&
						node.arguments.length === 1 &&
						node.arguments[0].type === 'Literal' &&
						typeof node.arguments[0].value === 'string'
					) {
						checkSpecifier(node.arguments[0], node.arguments[0].value);
					}
				},
			};
		},
	};
	return rule;
}

const noSharedToMainImports = createBoundaryRule({
	from: 'shared',
	to: 'main',
	description: 'Disallow src/shared/** importing src/main/**',
	message:
		'"{{from}}" imports "{{specifier}}", a src/shared -> src/main dependency. src/shared/** is compiled into the renderer program and maestro-lib must run without the desktop, so neither may depend on main-process code. Move the code into src/shared, or, for a service the desktop owns, route it through src/shared/maestro-lib/host.ts.',
});

const noMainToRendererImports = createBoundaryRule({
	from: 'main',
	to: 'renderer',
	description: 'Disallow src/main/** importing src/renderer/**',
	message:
		'"{{from}}" imports "{{specifier}}", a src/main -> src/renderer dependency. It works in dev and breaks the packaged app: the renderer build empties dist/renderer, so the main process cannot load the file. Move the code both sides need into src/shared.',
});

export default {
	rules: {
		'no-shared-to-main-imports': noSharedToMainImports,
		'no-main-to-renderer-imports': noMainToRendererImports,
	},
};
