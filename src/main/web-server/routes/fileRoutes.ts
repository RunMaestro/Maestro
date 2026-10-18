import type { FastifyInstance } from 'fastify';
import fs from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { getSshRemoteById } from '../../stores';
import { readBinaryFileBlockRemoteAsBase64, statRemote } from '../../utils/remote-fs';

/** Owner-authorized, explicit download. Never resolves a client path or an HTTP target. */
export class FileRoutes {
	constructor(private readonly securityToken: string) {}

	registerRoutes(server: FastifyInstance): void {
		server.get(`/${this.securityToken}/api/files/download`, async (request, reply) => {
			const query = request.query as { path?: string; sshRemoteId?: string };
			if (
				typeof query.path !== 'string' ||
				query.path.includes('\0') ||
				(query.sshRemoteId ? !path.posix.isAbsolute(query.path) : !path.isAbsolute(query.path))
			) {
				return reply.code(400).send({ error: 'An absolute host file path is required' });
			}
			if (
				query.sshRemoteId !== undefined &&
				(typeof query.sshRemoteId !== 'string' || !query.sshRemoteId)
			) {
				return reply.code(400).send({ error: 'Invalid SSH remote' });
			}
			const filename = query.sshRemoteId
				? path.posix.basename(query.path)
				: path.basename(query.path);
			const headers = {
				'content-type': 'application/octet-stream',
				'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16)}`)}`,
				'cache-control': 'no-store',
				'x-content-type-options': 'nosniff',
			};
			try {
				if (query.sshRemoteId) {
					const config = getSshRemoteById(query.sshRemoteId);
					if (!config) return reply.code(404).send({ error: 'SSH remote not found' });
					const stat = await statRemote(query.path, config);
					if (!stat.success || !stat.data)
						return reply.code(404).send({ error: stat.error || 'Host file not found' });
					if (stat.data.isDirectory)
						return reply.code(400).send({ error: 'Choose a file, not a directory' });
					const filePath = query.path;
					const size = stat.data.size;
					const stream = Readable.from(
						(async function* () {
							const blockSize = 1024 * 1024;
							for (let offset = 0; offset < size; offset += blockSize) {
								const block = await readBinaryFileBlockRemoteAsBase64(
									filePath,
									config,
									offset / blockSize,
									blockSize
								);
								if (!block.success || block.data === undefined)
									throw new Error(block.error || 'Host file read failed');
								const bytes = Buffer.from(block.data, 'base64');
								if (bytes.length !== Math.min(blockSize, size - offset))
									throw new Error('Host file changed during download');
								yield bytes;
							}
						})()
					);
					return reply.headers(headers).header('content-length', size).send(stream);
				}
				// Open first and stream the same descriptor: no whole-file allocation or stat/open race.
				const file = await fs.open(query.path, 'r');
				const stat = await file.stat();
				if (!stat.isFile()) {
					await file.close();
					return reply.code(400).send({ error: 'Choose a regular host file' });
				}
				return reply
					.headers(headers)
					.header('content-length', stat.size)
					.send(file.createReadStream());
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				return reply
					.code(code === 'ENOENT' ? 404 : code === 'EACCES' || code === 'EPERM' ? 403 : 500)
					.send({ error: error instanceof Error ? error.message : 'Host download failed' });
			}
		});
	}
}
