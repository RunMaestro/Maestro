/**
 * @file boundary-rules.test.ts
 * @description RuleTester coverage for the import-boundary lint rules
 * `no-shared-to-main-imports` (src/shared/** never reaches src/main/**) and
 * `no-main-to-renderer-imports` (src/main/** never reaches src/renderer/**).
 */

import { describe, it, afterAll } from 'vitest';
import { RuleTester } from 'eslint';
import sharedBoundary from '../../../eslint-rules/no-shared-to-main-imports.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
RuleTester.afterAll = afterAll;

const tester = new RuleTester({
	languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
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

tester.run('no-main-to-renderer-imports', sharedBoundary.rules['no-main-to-renderer-imports'], {
	valid: [
		{ filename: '/repo/src/main/a.ts', code: "import b from '../shared/b';" },
		{ filename: '/repo/src/main/a.ts', code: "import { app } from 'electron';" },
		{ filename: '/repo/src/renderer/a.ts', code: "import b from '../renderer/b';" },
		{ filename: '/repo/src/shared/a.ts', code: "import b from '../renderer/b';" },
	],
	invalid: [
		{
			// The 1.1.1-RC shape: a spawner reaching into a renderer component folder.
			filename: '/repo/src/main/process-manager/spawners/ClaudeSdkSpawner.ts',
			code: "import { encodeQuestionAnswer } from '../../../renderer/components/PermissionPrompt/questionAnswer';",
			errors: [{ messageId: 'newEdge' }],
		},
		{
			filename: '/repo/src/main/a.ts',
			code: "export * from '../renderer/b';",
			errors: [{ messageId: 'newEdge' }],
		},
		{
			filename: '/repo/src/main/a.ts',
			code: "const m = require('../renderer/b');",
			errors: [{ messageId: 'newEdge' }],
		},
	],
});
