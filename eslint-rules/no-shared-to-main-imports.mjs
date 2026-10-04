/**
 * ESLint rule: no-shared-to-main-imports
 *
 * `src/shared/**` is compiled by BOTH `tsconfig.main.json` and
 * `tsconfig.renderer.json`, so a shared file that imports from `src/main/**`
 * pulls main-process-only code (fs, child_process, electron-store, ...) into
 * the renderer's TypeScript program, and makes maestro-lib (which lives under
 * `src/shared/maestro-lib/`) depend on the desktop it is meant to run without.
 *
 * There are no exceptions. maestro-lib Part One arrived with 13 such edges;
 * they were retired by moving plain Node code into the library and routing
 * the few genuinely host-owned services (logging, crash reporting, capability
 * snapshots, the image store) through `src/shared/maestro-lib/host.ts`, which
 * the desktop registers into. A new need goes through that seam, not an
 * import.
 *
 * Scope: relative imports only. A bare specifier (an npm package) can never
 * resolve into `src/main`, so it is out of scope by construction.
 */

import path from 'node:path';
import { visitModuleSpecifiers } from './import-specifiers.mjs';

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
			description: 'Disallow src/shared/** importing src/main/**',
		},
		schema: [],
		messages: {
			newEdge:
				'"{{from}}" imports "{{specifier}}", a src/shared -> src/main dependency. src/shared/** is compiled into the renderer program and maestro-lib must run without the desktop, so neither may depend on main-process code. Move the code into src/shared, or, for a service the desktop owns, route it through src/shared/maestro-lib/host.ts.',
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

		return visitModuleSpecifiers((reportNode, specifier) => {
			if (typeof specifier !== 'string' || !specifier.startsWith('.')) {
				return;
			}
			if (!resolvesUnderMain(fromFilePosix, specifier)) {
				return;
			}
			context.report({
				node: reportNode,
				messageId: 'newEdge',
				data: { from: relativeToShared, specifier },
			});
		});
	},
};

export default {
	rules: {
		'no-shared-to-main-imports': noSharedToMainImports,
	},
};
