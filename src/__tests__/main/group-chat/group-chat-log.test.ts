/**
 * @file group-chat-log.test.ts
 * @description The desktop's `group-chat-log` is a re-export of the library module.
 *
 * The log format, escaping, and image saving are tested in
 * `src/shared/maestro-lib/groupchat/__tests__/log.test.ts`. This only guards
 * that the main-process import site still resolves every name.
 */

import { describe, it, expect } from 'vitest';
import * as shim from '../../../main/group-chat/group-chat-log';
import * as lib from '../../../shared/maestro-lib/groupchat/log';

describe('group-chat-log (desktop shim)', () => {
	it('re-exports the library implementation', () => {
		for (const name of [
			'escapeContent',
			'unescapeContent',
			'appendToLog',
			'readLog',
			'saveImage',
		] as const) {
			expect(shim[name]).toBe(lib[name]);
		}
	});
});
