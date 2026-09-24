/**
 * ESLint rule: no-shared-to-main-imports
 *
 * `src/shared/**` is compiled by BOTH `tsconfig.main.json` and
 * `tsconfig.renderer.json`, so a shared file that imports from `src/main/**`
 * pulls main-process-only code (fs, child_process, electron-store, ...) into
 * the renderer's TypeScript program. Nothing in the renderer, web-desktop, or
 * CLI currently imports maestro-lib, so today this is silent - but the only
 * thing keeping `child_process` out of a browser bundle is convention, and
 * that gap can grow unnoticed between maestro-lib Part One and Part Two.
 *
 * This rule pins the gap at its CURRENT size: it bans any `src/shared/**`
 * file from importing `src/main/**`, except the edges already known and
 * tracked below (all 13 introduced by maestro-lib Part One). Retiring one of
 * them - moving its dependency into the shared library proper - means
 * deleting its entry here, which is the point: the allowlist shrinking over
 * time is the visible signal that Part Two is closing the gap. Adding a new
 * entry should be rare and deliberate, not a way to silence the rule.
 *
 * Scope: relative imports only. A bare specifier (an npm package) can never
 * resolve into `src/main`, so it is out of scope by construction.
 */

import path from 'node:path';

// Keyed as `<path relative to src/shared/> -> <raw specifier as written>`.
const ALLOWED_EDGES = new Set([
	'maestro-lib/launch/ssh-spawn-wrapper.ts -> ../../../main/utils/ssh-remote-resolver',
	'maestro-lib/launch/ssh-spawn-wrapper.ts -> ../../../main/utils/ssh-command-builder',
	'maestro-lib/launch/ssh-spawn-wrapper.ts -> ../../../main/utils/logger',
	'maestro-lib/launch/path-prober.ts -> ../../../main/utils/sentry',
	'maestro-lib/launch/path-prober.ts -> ../../../main/utils/logger',
	'maestro-lib/launch/path-prober.ts -> ../../../main/utils/execFile',
	'maestro-lib/launch/agent-args.ts -> ../../../main/utils/logger',
	'maestro-lib/parsers/index.ts -> ../../../main/utils/logger',
	'maestro-lib/parsers/error-patterns.ts -> ../../../main/utils/logger',
	'maestro-lib/parsers/codex-output-parser.ts -> ../../../main/utils/sentry',
	'maestro-lib/parsers/opencode-output-parser.ts -> ../../../main/utils/terminalFilter',
	'maestro-lib/parsers/pi-output-parser.ts -> ../../../main/utils/terminalFilter',
	'maestro-lib/parsers/usage-aggregator.ts -> ../../../main/agents/capability-snapshot',
]);

const SHARED_ROOT_MARKER = 'src/shared/';

function toPosix(value) {
	return value.split(path.sep).join('/');
}

function resolvesUnderMain(fromFilePosix, specifier) {
	const resolved = path.posix
		.normalize(path.posix.join(path.posix.dirname(fromFilePosix), specifier))
		.replace(/^\.\.(\/|$)/, ''); // defensive; normalize shouldn't leave a leading .. here
	return resolved === 'src/main' || resolved.startsWith('src/main/');
}

/** @type {import('eslint').Rule.RuleModule} */
const noSharedToMainImports = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Disallow src/shared/** importing src/main/** except the tracked, pre-existing edges',
		},
		schema: [],
		messages: {
			newEdge:
				'"{{from}}" imports "{{specifier}}", a NEW src/shared -> src/main dependency. src/shared/** is compiled into the renderer program, which must not depend on main-process-only code (fs, child_process, electron). If this edge is genuinely required, add it to ALLOWED_EDGES in eslint-rules/no-shared-to-main-imports.mjs and record why.',
		},
	},
	create(context) {
		const filename = toPosix(context.filename ?? context.getFilename());
		const sharedIndex = filename.indexOf(SHARED_ROOT_MARKER);
		if (sharedIndex === -1) {
			return {};
		}
		const relativeToShared = filename.slice(sharedIndex + SHARED_ROOT_MARKER.length);
		const fromFilePosix = filename.slice(sharedIndex); // starts at "src/shared/..."

		function checkSpecifier(reportNode, specifier) {
			if (typeof specifier !== 'string' || !specifier.startsWith('.')) {
				return;
			}
			if (!resolvesUnderMain(fromFilePosix, specifier)) {
				return;
			}
			const edgeKey = `${relativeToShared} -> ${specifier}`;
			if (ALLOWED_EDGES.has(edgeKey)) {
				return;
			}
			context.report({
				node: reportNode,
				messageId: 'newEdge',
				data: { from: relativeToShared, specifier },
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

export default {
	rules: {
		'no-shared-to-main-imports': noSharedToMainImports,
	},
};
