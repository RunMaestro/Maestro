// Source: src/main/runtime/__tests__/getShellPath.test.ts
// Source: src/main/runtime/__tests__/path-prober.shell-path.spec.ts
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { beforeEach } from 'vitest';
import { peekShellPath } from '../getShellPath';
import { clearShellPathCache } from '../getShellPath';
import { refreshShellPath } from '../getShellPath';
import { vi } from 'vitest';
import { afterEach } from 'vitest';
import { getExpandedEnvWithShell } from '../../agents/path-prober';
import { checkBinaryExists } from '../../agents/path-prober';
import { getShellPath } from '../getShellPath';
import { execFileNoThrow } from '../../utils/execFile';
vi.mock('../../../shared/maestro-lib/launch/getShellPath', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../shared/maestro-lib/launch/getShellPath')>();
	return { ...actual, getShellPath: vi.fn(actual.getShellPath) };
});
vi.mock('../../../shared/maestro-lib/launch/exec-file', () => ({
	execFileNoThrow: vi.fn(),
}));
vi.mock('../../utils/logger', () => ({
	logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
describe('getShellPath', () => {
	describe('peekShellPath', () => {
		beforeEach(() => {
			clearShellPathCache();
		});

		it('returns null when no probe has completed', () => {
			expect(peekShellPath()).toBeNull();
		});

		it('returns the cached value after refreshShellPath resolves', async () => {
			const originalShell = process.env.SHELL;
			process.env.SHELL = '/bin/sh';
			try {
				let resolved: string;
				try {
					resolved = await refreshShellPath();
				} catch {
					// Some CI hosts won't have /bin/sh viable for our PATH probe.
					// In that case there's nothing to assert.
					return;
				}
				expect(peekShellPath()).toBe(resolved);
			} finally {
				if (originalShell === undefined) {
					delete process.env.SHELL;
				} else {
					process.env.SHELL = originalShell;
				}
			}
		});

		it('returns null again after clearShellPathCache', async () => {
			const originalShell = process.env.SHELL;
			process.env.SHELL = '/bin/sh';
			try {
				try {
					await refreshShellPath();
				} catch {
					return;
				}
				expect(peekShellPath()).not.toBeNull();

				clearShellPathCache();
				expect(peekShellPath()).toBeNull();
			} finally {
				if (originalShell === undefined) {
					delete process.env.SHELL;
				} else {
					process.env.SHELL = originalShell;
				}
			}
		});
	});
});
describe('path-prober.shell-path', () => {
	describe('path-prober shell path integration', () => {
		afterEach(() => vi.mocked(getShellPath).mockReset());
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it('should include shell PATH entries and prefer them when resolving with which', async () => {
			// Stub shell path to include a custom bin
			(getShellPath as any).mockResolvedValue('/tmp/custom/bin');

			const env = await getExpandedEnvWithShell();
			expect(env.PATH).toContain('/tmp/custom/bin');

			// Simulate which finding binary in shell path
			(execFileNoThrow as any).mockResolvedValue({
				exitCode: 0,
				stdout: '/tmp/custom/bin/node\n',
				stderr: '',
			});

			const result = await checkBinaryExists('node');
			expect(result.exists).toBe(true);
			expect(result.path).toBe('/tmp/custom/bin/node');
		});

		it('falls back to base PATH when getShellPath rejects and checkBinaryExists uses base PATH', async () => {
			// Simulate shell probe failing
			(getShellPath as any).mockRejectedValue(new Error('fail'));

			const env = await getExpandedEnvWithShell();
			// Should still return an env with a PATH (the base expanded PATH)
			expect(env.PATH).toBeDefined();
			expect((env.PATH ?? '').length).toBeGreaterThan(0);

			// Simulate which/where finding binary in base PATH
			(execFileNoThrow as any).mockResolvedValue({
				exitCode: 0,
				stdout: '/usr/bin/node\n',
				stderr: '',
			});

			const result = await checkBinaryExists('node');
			expect(result.exists).toBe(true);
			expect(result.path).toBe('/usr/bin/node');
		});
	});
});
