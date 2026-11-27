import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

// The web server streams the web-desktop bundle with @fastify/static (fs.open).
// Inside app.asar, Electron satisfies that open with a temp copy in $TMPDIR and
// caches the temp path for the life of the process. macOS purges untouched
// $TMPDIR files after a few days, and every asset then returns 500 ENOENT
// until restart (issue #2155). Unpacking the bundle makes the opens hit real
// files.
describe('electron-builder asarUnpack', () => {
	it('ships the web-desktop bundle outside app.asar', () => {
		const packageJsonPath = path.join(__dirname, '..', '..', '..', '..', 'package.json');
		const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
		expect(packageJson.build.asarUnpack).toContain('dist/web-desktop/**/*');
	});
});
