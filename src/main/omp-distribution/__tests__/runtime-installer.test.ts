import { describe, expect, it } from 'vitest';
import { installManagedRuntime, type RuntimeFileSystem } from '../runtime-installer';

function createMemoryFs(
	initialFiles: Record<string, Uint8Array> = {}
): RuntimeFileSystem & { files: Map<string, Uint8Array> } {
	const files = new Map(
		Object.entries(initialFiles).map(([path, value]) => [path, Buffer.from(value)])
	);
	const directories = new Set<string>(['/runtime']);
	return {
		files,
		async mkdir(path) {
			directories.add(path);
		},
		async writeFile(path, content) {
			files.set(path, Buffer.from(content));
		},
		async readFile(path) {
			const file = files.get(path);
			if (!file) throw new Error(`ENOENT ${path}`);
			return Buffer.from(file);
		},
		async exists(path) {
			return directories.has(path) || files.has(path);
		},
		async rename(from, to) {
			for (const directory of [...directories]) {
				if (directory === from || directory.startsWith(`${from}/`)) {
					directories.delete(directory);
					directories.add(`${to}${directory.slice(from.length)}`);
				}
			}
			for (const [file, content] of [...files]) {
				if (file.startsWith(`${from}/`)) {
					files.delete(file);
					files.set(`${to}${file.slice(from.length)}`, content);
				}
			}
		},
		async remove(path) {
			for (const directory of [...directories])
				if (directory === path || directory.startsWith(`${path}/`)) directories.delete(directory);
			for (const file of [...files.keys()])
				if (file === path || file.startsWith(`${path}/`)) files.delete(file);
		},
		async acquireLock(path) {
			if (files.has(path)) throw new Error('managed runtime install is already locked');
			files.set(path, Buffer.from('locked'));
			return async () => {
				files.delete(path);
			};
		},
	};
}

const request = {
	version: '16.4.8',
	executable: 'dist/cli.js',
	files: [
		{ path: 'dist/cli.js', content: Buffer.from('cli') },
		{ path: 'LICENSE', content: Buffer.from('MIT') },
	],
	notices: [{ path: 'LICENSE', content: Buffer.from('MIT') }],
};

describe('managed runtime installation', () => {
	it('atomically stages a versioned runtime, preserves notices, and records identity', async () => {
		const fs = createMemoryFs();
		const installed = await installManagedRuntime(fs, '/runtime', request);

		expect(installed).toEqual({
			directory: '/runtime/16.4.8',
			executable: '/runtime/16.4.8/dist/cli.js',
		});
		expect(
			Buffer.from(fs.files.get('/runtime/16.4.8/THIRD_PARTY_NOTICES/LICENSE') ?? '').toString()
		).toBe('MIT');
		expect(
			JSON.parse(Buffer.from(fs.files.get('/runtime/16.4.8/maestro-runtime.json') ?? '').toString())
		).toMatchObject({ version: '16.4.8' });
	});

	it('refuses downgrade, equivocation, bad executable selection, and concurrent install', async () => {
		const fs = createMemoryFs({
			'/runtime/current.json': Buffer.from(JSON.stringify({ version: '16.4.9', identity: 'old' })),
		});
		await expect(installManagedRuntime(fs, '/runtime', request)).rejects.toThrow('downgrade');
		await fs.writeFile(
			'/runtime/current.json',
			Buffer.from(JSON.stringify({ version: '16.4.8', identity: 'different' }))
		);
		await expect(installManagedRuntime(fs, '/runtime', request)).rejects.toThrow('equivocation');
		await expect(
			installManagedRuntime(createMemoryFs(), '/runtime', { ...request, executable: '../outside' })
		).rejects.toThrow('unsafe executable');
		const locked = createMemoryFs({ '/runtime/.install.lock': Buffer.from('held') });
		await expect(installManagedRuntime(locked, '/runtime', request)).rejects.toThrow(
			'already locked'
		);
	});

	it('rolls back the staged directory when a write fails', async () => {
		const fs = createMemoryFs();
		const writeFile = fs.writeFile;
		fs.writeFile = async (path, content) => {
			if (path.endsWith('/LICENSE')) throw new Error('disk full');
			await writeFile(path, content);
		};

		await expect(installManagedRuntime(fs, '/runtime', request)).rejects.toThrow('disk full');
		expect([...fs.files.keys()].some((path) => path.includes('.staging-'))).toBe(false);
	});
});
