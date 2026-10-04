/**
 * @file boundary-rules.test.ts
 * @description RuleTester coverage for the import-boundary lint rules:
 * `no-tui-outside-lib` (src/tui/** may reach only itself and the maestro-lib
 * public entry, never electron) and `no-shared-to-main-imports`, which shares
 * its specifier visitor.
 */

import { describe, it, afterAll } from 'vitest';
import { RuleTester } from 'eslint';
import tuiBoundary from '../../../eslint-rules/no-tui-outside-lib.mjs';
import sharedBoundary from '../../../eslint-rules/no-shared-to-main-imports.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
RuleTester.afterAll = afterAll;

const tester = new RuleTester({
	languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
});

const TUI_FILE = '/repo/src/tui/App.tsx';
const TUI_TEST_FILE = '/repo/src/tui/__tests__/App.test.tsx';

tester.run('no-tui-outside-lib', tuiBoundary.rules['no-tui-outside-lib'], {
	valid: [
		{ filename: TUI_FILE, code: "import { render } from 'ink';" },
		{ filename: TUI_FILE, code: "import fs from 'node:fs';" },
		{ filename: TUI_FILE, code: "import { parseTuiArgs } from './args';" },
		{ filename: TUI_TEST_FILE, code: "import { App } from '../App';" },
		// The public entry, spelled every way a bundler resolves it.
		{ filename: TUI_FILE, code: "import { resolveMaestroPaths } from '../shared/maestro-lib';" },
		{ filename: TUI_FILE, code: "import { x } from '../shared/maestro-lib/index';" },
		{ filename: TUI_FILE, code: "import { x } from '../shared/maestro-lib/index.ts';" },
		{ filename: TUI_TEST_FILE, code: "import { x } from '../../shared/maestro-lib';" },
		{ filename: TUI_FILE, code: "export { x } from '../shared/maestro-lib';" },
		// Files outside src/tui are not this rule's business.
		{ filename: '/repo/src/main/index.ts', code: "import { app } from 'electron';" },
		{ filename: '/repo/src/shared/x.ts', code: "import y from '../main/y';" },
	],
	invalid: [
		{
			filename: TUI_FILE,
			code: "import { buildLaunchPlan } from '../shared/maestro-lib/launch/launch-plan';",
			errors: [{ messageId: 'outsideLib' }],
		},
		{
			filename: TUI_FILE,
			code: "import { x } from '../main/stores/instances';",
			errors: [{ messageId: 'outsideLib' }],
		},
		{
			filename: TUI_FILE,
			code: "import { x } from '../renderer/utils/ids';",
			errors: [{ messageId: 'outsideLib' }],
		},
		{
			filename: TUI_FILE,
			code: "import { generateId } from '../shared/formatters';",
			errors: [{ messageId: 'outsideLib' }],
		},
		{
			filename: TUI_TEST_FILE,
			code: "import { x } from '../../shared/maestro-lib/run/start-turn';",
			errors: [{ messageId: 'outsideLib' }],
		},
		{
			filename: TUI_FILE,
			code: "import { app } from 'electron';",
			errors: [{ messageId: 'electron' }],
		},
		{
			filename: TUI_FILE,
			code: "import { x } from 'electron/main';",
			errors: [{ messageId: 'electron' }],
		},
		// Every other way to name a module is a dependency too.
		{
			filename: TUI_FILE,
			code: "export * from '../main/x';",
			errors: [{ messageId: 'outsideLib' }],
		},
		{
			filename: TUI_FILE,
			code: "export { y } from '../shared/maestro-lib/launch/env';",
			errors: [{ messageId: 'outsideLib' }],
		},
		{
			filename: TUI_FILE,
			code: "const m = await import('../main/x');",
			errors: [{ messageId: 'outsideLib' }],
		},
		{
			filename: TUI_FILE,
			code: "const m = require('electron');",
			errors: [{ messageId: 'electron' }],
		},
	],
});

tester.run('no-shared-to-main-imports', sharedBoundary.rules['no-shared-to-main-imports'], {
	valid: [
		{ filename: '/repo/src/shared/a.ts', code: "import b from './b';" },
		{ filename: '/repo/src/shared/a.ts', code: "import fs from 'fs';" },
		{ filename: '/repo/src/main/a.ts', code: "import b from './b';" },
	],
	invalid: [
		{
			filename: '/repo/src/shared/a.ts',
			code: "import b from '../main/b';",
			errors: [{ messageId: 'newEdge' }],
		},
		{
			filename: '/repo/src/shared/maestro-lib/a.ts',
			code: "export * from '../../main/b';",
			errors: [{ messageId: 'newEdge' }],
		},
		{
			filename: '/repo/src/shared/a.ts',
			code: "const m = await import('../main/b');",
			errors: [{ messageId: 'newEdge' }],
		},
	],
});
