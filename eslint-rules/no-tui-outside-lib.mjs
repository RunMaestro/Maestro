/**
 * ESLint rule: no-tui-outside-lib
 *
 * `src/tui/**` is the proof that maestro-lib runs Maestro with no Electron, so
 * it may reach only two places: itself, and the library's public entry
 * (`src/shared/maestro-lib/index.ts`). A deep import such as
 * `maestro-lib/launch/env` would let the TUI lean on something the library
 * never promised, and an import from `src/main` or `electron` would make the
 * proof vacuous. If the TUI needs something the library lacks, add it to the
 * library and export it from the entry.
 *
 * Scope: relative specifiers are resolved against the importing file. Bare
 * specifiers are npm packages and Node built-ins, which are fine, except
 * `electron` (and its subpaths), which is always forbidden.
 */

import path from 'node:path';
import { visitModuleSpecifiers } from './import-specifiers.mjs';

const TUI_ROOT_MARKER = 'src/tui/';
const TUI_ROOT = 'src/tui';
const LIB_ENTRY_BASE = 'src/shared/maestro-lib/index';
const LIB_DIR = 'src/shared/maestro-lib';
const ENTRY_EXTENSIONS = new Set(['', '.ts', '.tsx', '.js', '.mjs', '.cjs']);

function toPosix(value) {
	return value.split(path.sep).join('/');
}

function isElectron(specifier) {
	return specifier === 'electron' || specifier.startsWith('electron/');
}

function isUnder(resolved, root) {
	return resolved === root || resolved.startsWith(`${root}/`);
}

/** True when `resolved` names the library's public entry, with or without `/index` or an extension. */
function isLibEntry(resolved) {
	if (resolved === LIB_DIR) {
		return true;
	}
	for (const extension of ENTRY_EXTENSIONS) {
		if (resolved === `${LIB_ENTRY_BASE}${extension}`) {
			return true;
		}
	}
	return false;
}

/** @type {import('eslint').Rule.RuleModule} */
const noTuiOutsideLib = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Restrict src/tui/** to itself and the maestro-lib public entry, and forbid electron',
		},
		schema: [],
		messages: {
			outsideLib:
				'"{{from}}" imports "{{specifier}}", which is outside src/tui/ and is not the maestro-lib public entry. The TUI may import only src/tui/** and src/shared/maestro-lib/index.ts. If it needs something the library lacks, add it to the library and export it from the entry.',
			electron:
				'"{{from}}" imports "{{specifier}}". The TUI runs without Electron; it must not depend on it.',
		},
	},
	create(context) {
		const filename = toPosix(context.filename ?? context.getFilename());
		const tuiIndex = filename.indexOf(TUI_ROOT_MARKER);
		if (tuiIndex === -1) {
			return {};
		}
		const relativeToTui = filename.slice(tuiIndex + TUI_ROOT_MARKER.length);
		const fromFilePosix = filename.slice(tuiIndex); // starts at "src/tui/..."

		return visitModuleSpecifiers((reportNode, specifier) => {
			if (typeof specifier !== 'string') {
				return;
			}
			if (isElectron(specifier)) {
				context.report({
					node: reportNode,
					messageId: 'electron',
					data: { from: relativeToTui, specifier },
				});
				return;
			}
			if (!specifier.startsWith('.')) {
				return;
			}
			const resolved = path.posix.normalize(
				path.posix.join(path.posix.dirname(fromFilePosix), specifier)
			);
			if (isUnder(resolved, TUI_ROOT) || isLibEntry(resolved)) {
				return;
			}
			context.report({
				node: reportNode,
				messageId: 'outsideLib',
				data: { from: relativeToTui, specifier },
			});
		});
	},
};

export default {
	rules: {
		'no-tui-outside-lib': noTuiOutsideLib,
	},
};
