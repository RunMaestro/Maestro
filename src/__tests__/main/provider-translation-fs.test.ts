// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createSshTranslationFs } from '../../main/provider-translation-fs';
import type { RemoteFsDeps } from '../../main/utils/remote-fs';
import type { SshRemoteConfig } from '../../shared/types';

const remote: SshRemoteConfig = {
	id: 'remote',
	name: 'Remote',
	host: 'example.invalid',
	port: 22,
	username: 'tester',
	privateKeyPath: '',
	enabled: true,
};

describe('SSH translation filesystem', () => {
	it('rejects invalid base64 and a realpath result whose final component is missing', async () => {
		const deps: RemoteFsDeps = {
			execSsh: vi.fn().mockResolvedValue({ stdout: 'invalid!', stderr: '', exitCode: 0 }),
			buildSshArgs: () => ['host'],
		};
		const nativeFs = createSshTranslationFs(remote, deps);
		await expect(nativeFs.readFile('/remote/file')).rejects.toThrow('Invalid remote base64');
		vi.mocked(deps.execSsh)
			.mockResolvedValueOnce({ stdout: '/remote/missing\n', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({ stdout: '', stderr: 'No such file or directory', exitCode: 1 });
		await expect(nativeFs.realpath('/remote/missing')).rejects.toMatchObject({ code: 'ENOENT' });
		vi.mocked(deps.execSsh)
			.mockClear()
			.mockResolvedValue({ stdout: '', stderr: 'Connection closed', exitCode: 255 });
		await expect(nativeFs.unlink('/remote/file')).rejects.toThrow('Connection closed');
		expect(deps.execSsh).toHaveBeenCalledOnce();
	});
	it('carries binary bytes over stdin, preserves modes and acknowledges ownership only after success', async () => {
		const deps: RemoteFsDeps = {
			execSsh: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
			buildSshArgs: () => ['host'],
		};
		const nativeFs = createSshTranslationFs(remote, deps);
		const bytes = Buffer.from([0, 255, 128, 10]);
		const onCreated = vi.fn();
		await nativeFs.createExclusive('/remote/file', bytes, {
			mode: 0o700,
			durable: true,
			onCreated,
		});
		expect(onCreated).toHaveBeenCalledOnce();
		expect(vi.mocked(deps.execSsh).mock.calls[0][2]).toBe(bytes.toString('base64'));
		expect(vi.mocked(deps.execSsh).mock.calls[0][1].at(-1)).toContain('chmod 700');
		vi.mocked(deps.execSsh).mockResolvedValue({
			stdout: bytes.toString('base64'),
			stderr: '',
			exitCode: 0,
		});
		expect(await nativeFs.readFile('/remote/file')).toEqual(bytes);
	});

	it.each([
		[73, 'already exists', 'EEXIST'],
		[255, 'Connection closed', 'EIO'],
	] as const)(
		'does not claim ownership or retry a refused/ambiguous write (%s)',
		async (exitCode, stderr, code) => {
			const deps: RemoteFsDeps = {
				execSsh: vi.fn().mockResolvedValue({ stdout: '', stderr, exitCode }),
				buildSshArgs: () => ['host'],
			};
			const onCreated = vi.fn();
			await expect(
				createSshTranslationFs(remote, deps).createExclusive('/remote/file', 'data', { onCreated })
			).rejects.toMatchObject({ code });
			expect(onCreated).not.toHaveBeenCalled();
			expect(deps.execSsh).toHaveBeenCalledOnce();
		}
	);

	it('distinguishes absence from permission errors and resolves stat through a symlink', async () => {
		const deps: RemoteFsDeps = {
			execSsh: vi
				.fn()
				.mockResolvedValue({ stdout: '', stderr: 'No such file or directory', exitCode: 1 }),
			buildSshArgs: () => ['host'],
		};
		const nativeFs = createSshTranslationFs(remote, deps);
		expect(await nativeFs.exists('/remote/missing')).toBe(false);
		vi.mocked(deps.execSsh).mockResolvedValueOnce({
			stdout: '',
			stderr: 'Permission denied',
			exitCode: 1,
		});
		await expect(nativeFs.exists('/remote/private')).rejects.toMatchObject({ code: 'EACCES' });
		vi.mocked(deps.execSsh)
			.mockResolvedValueOnce({ stdout: 'G|12|a1ff|10\n', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({ stdout: '/remote/target\n', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({ stdout: 'B|3|100600|20\n', stderr: '', exitCode: 0 });
		const stat = await nativeFs.stat('/remote/link');
		expect(stat.size).toBe(3);
		expect(stat.mtimeMs).toBe(20_000);
		expect(stat.mode & 0o777).toBe(0o600);
		expect(stat.isSymbolicLink()).toBe(false);
	});
});
