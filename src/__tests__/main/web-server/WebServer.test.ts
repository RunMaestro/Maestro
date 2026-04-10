import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { captureException } from '../../../main/utils/sentry';
import { WebServer } from '../../../main/web-server/WebServer';

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

describe('WebServer web asset resolution', () => {
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

	it('reports and rethrows unexpected asset inspection failures', () => {
		const distWebDir = path.join(tempRoot, 'dist', 'web');
		const indexPath = path.join(distWebDir, 'index.html');
		mkdirSync(indexPath, { recursive: true });

		expect(() => new WebServer(0)).toThrow();

		const [[capturedError, captureContext]] = vi.mocked(captureException).mock.calls;
		expect((capturedError as NodeJS.ErrnoException).code).toBe('EISDIR');
		expect(captureContext).toEqual({
			operation: 'webServer:isServableWebAssetsPath',
			candidatePath: distWebDir,
			indexPath,
		});
	});
});
