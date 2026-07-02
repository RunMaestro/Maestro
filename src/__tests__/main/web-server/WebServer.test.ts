import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { WebServer } from '../../../main/web-server/WebServer';

// Keep Sentry inert; constructing a WebServer should never reach it.
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

describe('WebServer PWA asset resolution', () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(path.join(os.tmpdir(), 'maestro-web-assets-'));
		vi.spyOn(process, 'cwd').mockReturnValue(tempRoot);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it('resolves PWA assets from the built web-desktop bundle', () => {
		// The web-desktop vite publicDir copies src/web/public/* (manifest.json,
		// service worker, icons/) into dist/web-desktop, so that directory is the
		// PWA asset root. manifest.json is the marker file we probe for.
		const bundleDir = path.join(tempRoot, 'dist', 'web-desktop');
		mkdirSync(bundleDir, { recursive: true });
		writeFileSync(path.join(bundleDir, 'manifest.json'), '{"name":"Maestro"}');

		const server = new WebServer(0);

		expect((server as any).webAssetsPath).toBe(bundleDir);
	});

	it('returns null when no built bundle provides PWA assets', () => {
		// Empty cwd, and the source web-desktop dir ships no manifest.json, so no
		// candidate path resolves.
		const server = new WebServer(0);

		expect((server as any).webAssetsPath).toBeNull();
	});
});
