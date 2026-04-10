import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { WebServer } from '../../../main/web-server/WebServer';

describe('WebServer web asset resolution', () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(path.join(os.tmpdir(), 'maestro-web-assets-'));
		vi.spyOn(process, 'cwd').mockReturnValue(tempRoot);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it('prefers built dist/web assets over the source web index', () => {
		const distWebDir = path.join(tempRoot, 'dist', 'web');
		mkdirSync(distWebDir, { recursive: true });
		writeFileSync(
			path.join(distWebDir, 'index.html'),
			'<script type="module" src="./assets/main.js"></script>'
		);

		const server = new WebServer(0);

		expect((server as any).webAssetsPath).toBe(distWebDir);
	});

	it('rejects source web assets that still reference /main.tsx when no built bundle exists', () => {
		const server = new WebServer(0);

		expect((server as any).webAssetsPath).toBeNull();
	});
});
