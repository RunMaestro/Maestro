import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { captureException } from '../../../main/utils/sentry';
import { WebServer } from '../../../main/web-server/WebServer';

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

// The LAN address probe touches the real network; pin it. The address watcher
// still needs the module's other exports.
vi.mock('../../../main/utils/networkUtils', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/utils/networkUtils')>()),
	getLocalIpAddress: vi.fn().mockResolvedValue('192.168.1.50'),
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
		mkdirSync(path.join(distWebDir, 'assets'), { recursive: true });
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

describe('WebServer network exposure', () => {
	let server: WebServer | null = null;

	afterEach(async () => {
		await server?.stop();
		server = null;
	});

	function boundAddress(s: WebServer): string | undefined {
		const address = s.getServer().server.address();
		return address && typeof address === 'object' ? address.address : undefined;
	}

	it('listens on loopback only and advertises 127.0.0.1 by default', async () => {
		server = new WebServer(0);
		const { url } = await server.start();

		expect(server.isLanAccessible()).toBe(false);
		expect(boundAddress(server)).toBe('127.0.0.1');
		expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
	});

	it('listens on every interface and advertises the LAN address when asked for LAN access', async () => {
		server = new WebServer(0, undefined, { lanAccess: true });
		const { url } = await server.start();

		expect(server.isLanAccessible()).toBe(true);
		expect(boundAddress(server)).toBe('0.0.0.0');
		expect(url).toMatch(/^http:\/\/192\.168\.1\.50:\d+\//);
	});
});

describe('WebServer origin policy', () => {
	let server: WebServer;

	beforeEach(async () => {
		server = new WebServer(0);
		await server.start();
	});

	afterEach(async () => {
		await server.stop();
	});

	function get(headers: Record<string, string>) {
		return server.getServer().inject({ method: 'GET', url: '/health', headers });
	}

	it('serves requests with no Origin header (maestro-cli, same-origin GETs)', async () => {
		const res = await get({ host: '127.0.0.1:1234' });
		expect(res.statusCode).toBe(200);
	});

	it('serves requests whose Origin is the host they were sent to', async () => {
		const res = await get({ host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234' });
		expect(res.statusCode).toBe(200);
	});

	it('refuses a foreign Origin and sends no CORS grant', async () => {
		const res = await get({ host: '127.0.0.1:1234', origin: 'https://evil.example' });
		expect(res.statusCode).toBe(403);
		expect(res.headers['access-control-allow-origin']).toBeUndefined();
	});

	it('refuses the opaque "null" Origin a sandboxed iframe sends', async () => {
		const res = await get({ host: '127.0.0.1:1234', origin: 'null' });
		expect(res.statusCode).toBe(403);
	});

	it('refuses a cross-origin POST outright instead of only hiding the response', async () => {
		const res = await server.getServer().inject({
			method: 'POST',
			url: `/${server.getSecurityToken()}/api/session/abc/send`,
			headers: {
				host: '127.0.0.1:1234',
				origin: 'https://evil.example',
				'content-type': 'text/plain',
			},
			payload: '{"command":"echo pwned"}',
		});
		expect(res.statusCode).toBe(403);
	});

	it('serves the trusted tunnel origin even when the Host header differs', async () => {
		server.setTrustedOriginsProvider(() => ['https://abc-def.trycloudflare.com']);
		const res = await get({
			host: '127.0.0.1:1234',
			origin: 'https://abc-def.trycloudflare.com',
		});
		expect(res.statusCode).toBe(200);
	});
});
