import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { App } from 'electron';

const handlers = vi.hoisted(
	() =>
		new Map<
			string,
			(...args: unknown[]) => Promise<{ success: boolean; path?: string; error?: string }>
		>()
);
vi.mock('electron', () => ({
	ipcMain: {
		handle: (
			channel: string,
			handler: (...args: unknown[]) => Promise<{ success: boolean; path?: string; error?: string }>
		) => handlers.set(channel, handler),
	},
}));
vi.mock('../../../../main/stores', () => ({ getSshRemoteById: () => undefined }));
vi.mock('../../../../main/utils/remote-fs', () => ({
	statRemote: vi.fn(),
	readBinaryFileBlockRemoteAsBase64: vi.fn(),
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { FileRoutes } from '../../../../main/web-server/routes/fileRoutes';
import { registerAttachmentsHandlers } from '../../../../main/ipc/handlers/attachments';
import { getHostDirectoryInfo } from '../../../../main/utils/host-directory';

let directory: string;
let server: FastifyInstance;
let address: string;
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-transfer-'));
	server = Fastify({ forceCloseConnections: true });
	new FileRoutes('owner-token').registerRoutes(server);
	address = await server.listen({ host: '127.0.0.1', port: 0 });
	registerAttachmentsHandlers({ app: { getPath: () => directory } as unknown as App });
});
afterEach(async () => {
	await server.close();
	await fs.rm(directory, { recursive: true, force: true });
	handlers.clear();
});

async function download(filePath: string, extra = ''): Promise<Response> {
	return fetch(
		`${address}/owner-token/api/files/download?path=${encodeURIComponent(filePath)}${extra}`
	);
}

describe('explicit host file transfer', () => {
	it('uploads exact binary bytes into host storage then downloads them through the live HTTP server', async () => {
		const bytes = Buffer.from([0, 255, 128, 10, 13, 0, 42]);
		const saved = await handlers.get('attachments:save')!(
			{},
			'host-session',
			bytes.toString('base64'),
			'binary file.bin'
		);
		expect(saved.success).toBe(true);
		expect(saved.path).toBe(path.join(directory, 'attachments', 'host-session', 'binary file.bin'));
		expect(await fs.readFile(saved.path!)).toEqual(bytes);
		const response = await download(saved.path!);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-disposition')).toContain(
			"filename*=UTF-8''binary%20file.bin"
		);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
	});

	it.each(['../escape.bin', '..\\escape.bin', 'x/../../escape.bin', 'data:stream', '', '.', '..'])(
		'rejects uploaded filename %j rather than rewriting its destination',
		async (filename) => {
			const saved = await handlers.get('attachments:save')!(
				{},
				'host-session',
				Buffer.from('private').toString('base64'),
				filename
			);
			expect(saved.success).toBe(false);
			expect(saved.error).toContain('single file name');
			expect(await fs.readdir(directory)).toEqual([]);
		}
	);

	it.each(['../outside', 'folder\\outside', 'C:stream', '\0'])(
		'rejects session path %j',
		async (sessionId) => {
			const saved = await handlers.get('attachments:save')!({}, sessionId, 'AA==', 'file.bin');
			expect(saved.success).toBe(false);
			expect(await fs.readdir(directory)).toEqual([]);
		}
	);

	it('rejects a session attachment junction that escapes the store without overwriting outside data', async () => {
		const root = path.join(directory, 'attachments');
		const outside = path.join(directory, 'outside');
		await fs.mkdir(root);
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, 'file.bin'), 'original');
		await fs.symlink(outside, path.join(root, 'linked-session'), 'junction');
		const saved = await handlers.get('attachments:save')!({}, 'linked-session', 'AA==', 'file.bin');
		expect(saved.success).toBe(false);
		expect(saved.error).toContain('escapes');
		expect(await fs.readFile(path.join(outside, 'file.bin'), 'utf8')).toBe('original');
	});

	it('does not overwrite a preexisting attachment file symlink', async () => {
		const session = path.join(directory, 'attachments', 'host-session');
		await fs.mkdir(session, { recursive: true });
		const outside = path.join(directory, 'private.bin');
		await fs.writeFile(outside, 'original');
		await fs.symlink(outside, path.join(session, 'file.bin'), 'file');
		const saved = await handlers.get('attachments:save')!({}, 'host-session', 'AA==', 'file.bin');
		expect(saved.success).toBe(false);
		expect(saved.error).toContain('symlink');
		expect(await fs.readFile(outside, 'utf8')).toBe('original');
	});

	it.each(['../secret', 'http://127.0.0.1:9999/private', 'file:///private', '\0'])(
		'does not interpret %j as a download target',
		async (target) => {
			const response = await download(target);
			expect(response.status).toBe(400);
		}
	);

	it('rejects directories, missing files, unknown remotes, and a wrong route token', async () => {
		expect((await download(directory)).status).toBe(400);
		expect((await download(path.join(directory, 'missing'))).status).toBe(404);
		expect((await download('/file.bin', '&sshRemoteId=not-configured')).status).toBe(404);
		expect(
			(
				await fetch(
					`${address}/wrong-token/api/files/download?path=${encodeURIComponent(directory)}`
				)
			).status
		).toBe(404);
	});
});

describe('host directory navigation', () => {
	it('returns host-canonical directory and parent, including legitimate parent traversal', async () => {
		const child = path.join(directory, 'child');
		await fs.mkdir(child);
		const info = await getHostDirectoryInfo(path.join(child, '..'));
		expect(info.path).toBe(await fs.realpath(directory));
		expect(info.parent).toBe(path.dirname(info.path));
		expect(info.roots).toContain(path.parse(info.path).root);
	});
	it('rejects relative, invalid, and file paths instead of resolving client paths', async () => {
		await expect(getHostDirectoryInfo('client-relative')).rejects.toThrow('absolute');
		await expect(getHostDirectoryInfo('\0')).rejects.toThrow('absolute');
		const file = path.join(directory, 'file');
		await fs.writeFile(file, 'not a directory');
		await expect(getHostDirectoryInfo(file)).rejects.toThrow('not a directory');
	});
});
