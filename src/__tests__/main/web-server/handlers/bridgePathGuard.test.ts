import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
	bridgeGuardViolation,
	findProtectedPathArg,
	setBridgeGuardContextProvider,
	settingsWriteChangesComputerHistory,
	type BridgeGuardContext,
} from '../../../../main/web-server/handlers/bridgePathGuard';

let userData: string;
let ctx: BridgeGuardContext;

beforeEach(() => {
	userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-guard-')));
	fs.mkdirSync(path.join(userData, 'computer-history', 'segments'), { recursive: true });
	ctx = {
		userDataDir: userData,
		encoreFeatures: { computerHistory: true },
		platform: process.platform,
	};
	setBridgeGuardContextProvider(() => ctx);
});
afterEach(() => {
	setBridgeGuardContextProvider(null);
	fs.rmSync(userData, { recursive: true, force: true });
});

describe('findProtectedPathArg', () => {
	const store = () => path.join(userData, 'computer-history');

	it('refuses the store, anything inside it, and the CLI discovery file', () => {
		expect(findProtectedPathArg('fs:readDir', [store()], ctx)).not.toBeNull();
		expect(
			findProtectedPathArg('fs:readFile', [path.join(store(), 'index.jsonl')], ctx)
		).not.toBeNull();
		expect(
			findProtectedPathArg('fs:writeFile', [path.join(store(), 'segments', 'new.jsonl'), 'x'], ctx)
		).not.toBeNull();
		expect(
			findProtectedPathArg('fs:readFile', [path.join(userData, 'cli-server.json')], ctx)
		).not.toBeNull();
	});

	it('sees through nesting, relative segments, file:// URLs, and symlinked parents', () => {
		const inside = path.join(store(), 'config.json');
		expect(findProtectedPathArg('x:y', [{ opts: { paths: ['a', inside] } }], ctx)).not.toBeNull();
		expect(
			findProtectedPathArg(
				'fs:readFile',
				[path.join(userData, 'other', '..', 'computer-history', 'SCHEMA.md')],
				ctx
			)
		).not.toBeNull();
		expect(findProtectedPathArg('fs:readFile', [pathToFileURL(inside).href], ctx)).not.toBeNull();
		const link = path.join(userData, 'innocent-link');
		fs.symlinkSync(store(), link, process.platform === 'win32' ? 'junction' : 'dir');
		expect(
			findProtectedPathArg('fs:writeFile', [path.join(link, 'not-yet.jsonl')], ctx)
		).not.toBeNull();
	});

	it('is case-insensitive on macOS and Windows', () => {
		const upper = path.join(userData, 'COMPUTER-HISTORY', 'index.jsonl');
		expect(
			findProtectedPathArg('fs:readFile', [upper], { ...ctx, platform: 'darwin' })
		).not.toBeNull();
	});

	it('refuses an ANCESTOR only on channels that destroy, move, or duplicate a tree', () => {
		expect(findProtectedPathArg('fs:delete', [userData], ctx)).not.toBeNull();
		expect(findProtectedPathArg('fs:rename', [userData, '/tmp/x'], ctx)).not.toBeNull();
		expect(findProtectedPathArg('fs:readDir', [userData], ctx)).toBeNull();
	});

	it('refuses copying or archiving a parent of the store: the copy would carry it out', () => {
		const elsewhere = path.join(os.tmpdir(), 'bridge-guard-copy-target');
		expect(findProtectedPathArg('fs:copyPath', [userData, elsewhere], ctx)).not.toBeNull();
		expect(findProtectedPathArg('fs:compressFolder', [userData], ctx)).not.toBeNull();
		// A sibling that merely lives beside the store is still fine to copy.
		fs.mkdirSync(path.join(userData, 'history'));
		expect(
			findProtectedPathArg('fs:copyPath', [path.join(userData, 'history'), elsewhere], ctx)
		).toBeNull();
	});

	it('still resolves a path longer than a typical OS limit', () => {
		// Windows collapses `.\\` padding back onto the real file, so a length
		// cap at a POSIX-sized limit let a padded path through unchecked.
		// Built by hand: path.join would normalize the padding away.
		const padded = [userData, ...Array(2500).fill('.'), 'computer-history', 'index.jsonl'].join(
			path.sep
		);
		expect(padded.length).toBeGreaterThan(4096);
		expect(findProtectedPathArg('fs:readFile', [padded], ctx)).not.toBeNull();
	});

	it('refuses an fs: call whose arguments are too large to scan', () => {
		const padding = Array.from({ length: 2500 }, (_, i) => `junk-${i}`);
		const inside = path.join(store(), 'index.jsonl');
		// The protected path sits past the scan limit: it must not ride through.
		expect(findProtectedPathArg('fs:readFile', [{ padding, path: inside }], ctx)).not.toBeNull();
		// Namespaces that send big trees by design keep working.
		expect(findProtectedPathArg('sessions:setMany', [padding], ctx)).toBeNull();
	});

	it('leaves unrelated paths and plain strings alone', () => {
		expect(
			findProtectedPathArg('fs:readFile', [path.join(userData, 'maestro-settings.json')], ctx)
		).toBeNull();
		expect(
			findProtectedPathArg('settings:get', ['theme', 42, null, { a: 'dracula' }], ctx)
		).toBeNull();
		expect(
			findProtectedPathArg('fs:readFile', [path.join(userData, 'computer-history-old', 'x')], ctx)
		).toBeNull();
	});
});

describe('Computer History flag writes', () => {
	it('settingsWriteChangesComputerHistory compares against the current flag', () => {
		expect(
			settingsWriteChangesComputerHistory('encoreFeatures', { computerHistory: false }, true)
		).toBe(true);
		expect(
			settingsWriteChangesComputerHistory(
				'encoreFeatures',
				{ computerHistory: true, usageStats: false },
				true
			)
		).toBe(false);
		// Omitting the key resolves to the default (off): that is a change when it is on.
		expect(settingsWriteChangesComputerHistory('encoreFeatures', { usageStats: true }, true)).toBe(
			true
		);
		expect(settingsWriteChangesComputerHistory('encoreFeatures.computerHistory', true, false)).toBe(
			true
		);
		expect(settingsWriteChangesComputerHistory('activeThemeId', 'x', true)).toBe(false);
	});

	it('bridgeGuardViolation refuses flag flips and the marketplace toggle, allows other writes', () => {
		expect(
			bridgeGuardViolation('settings:set', ['encoreFeatures', { computerHistory: false }])
		).toMatch(/desktop app/);
		expect(
			bridgeGuardViolation('plugins:first-party-set-enabled', ['computerHistory', true])
		).toMatch(/desktop app/);
		expect(
			bridgeGuardViolation('plugins:first-party-set-enabled', ['maestroCue', true])
		).toBeNull();
		expect(
			bridgeGuardViolation('settings:set', ['encoreFeatures', { computerHistory: true }])
		).toBeNull();
		expect(
			bridgeGuardViolation('fs:readFile', [path.join(userData, 'computer-history', 'index.jsonl')])
		).toMatch(/may not touch computer-history/);
	});
});
