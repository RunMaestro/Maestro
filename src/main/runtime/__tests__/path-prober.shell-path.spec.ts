import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub getShellPath before importing path-prober
vi.mock('../../runtime/getShellPath', () => ({
	getShellPath: vi.fn(),
}));

vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { getExpandedEnvWithShell, checkBinaryExists } from '../../../main/agents/path-prober';
import { getShellPath } from '../../runtime/getShellPath';
import { execFileNoThrow } from '../../../main/utils/execFile';

describe('path-prober shell path integration', () => {
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
