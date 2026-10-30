/**
 * The Windows portable build must unpack into a directory of its own on every
 * launch.
 *
 * electron-builder's portable launcher (app-builder-lib
 * templates/nsis/portable.nsi) extracts the app into `$INSTDIR`, runs it, and
 * then `RMDir /r $INSTDIR` - and it also wipes `$INSTDIR` BEFORE extracting.
 * By default `$INSTDIR` is `$TEMP\<ksuid of the build>`, the SAME folder for
 * every launch of one build. Launching the portable exe a second time (the
 * single-instance lock sends the new process away at once) therefore deletes
 * every file of the RUNNING instance that is not held open: the bundled
 * prompts under `resources/prompts` vanish mid-session. In the field that was
 * MAESTRO-RE / MAESTRO-YF (all 33 `resources/prompts/bmad/*.md` ENOENT, from
 * `Temp\<same name on different machines>\resources`) and MAESTRO-J0
 * (`Failed to load required prompt` with an `app.second-instance` breadcrumb).
 *
 * Only a truthy NON-string `unpackDirName` avoids that. NsisTarget defines
 * `UNPACK_DIR_NAME` when the option is a string OR falsy
 * (`typeof unpackDirName === "string" || !unpackDirName`), so `false` - which
 * the option's docs describe as "unique per launch" - still gets the shared
 * ksuid folder. With `true` nothing is defined and the template falls back to
 * `$PLUGINSDIR\app`, which NSIS creates fresh for every launch.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const pkg = JSON.parse(readFileSync(path.join(__dirname, '../../../package.json'), 'utf-8')) as {
	build: { win: { target: Array<{ target: string }> }; portable?: { unpackDirName?: unknown } };
};

describe('portable build unpack directory', () => {
	it('ships a portable target', () => {
		expect(pkg.build.win.target.map((t) => t.target)).toContain('portable');
	});

	it('unpacks each launch into its own $PLUGINSDIR, never a shared $TEMP folder', () => {
		const unpackDirName = pkg.build.portable?.unpackDirName;
		// The exact predicate NsisTarget uses to pin the shared folder.
		const pinsSharedFolder = typeof unpackDirName === 'string' || !unpackDirName;
		expect(pinsSharedFolder).toBe(false);
	});
});
