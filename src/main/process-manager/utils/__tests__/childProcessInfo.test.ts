import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getChildProcesses } from '../childProcessInfo';

// Note: this test mocks execFile (not exec) — the implementation uses execFile
// which is safe from shell injection by design.

// Mock child_process.execFile
vi.mock('child_process', () => {
	const mockExecFile = vi.fn();
	return {
		execFile: mockExecFile,
		default: { execFile: mockExecFile },
	};
});

// Mock platform detection
vi.mock('../../../../shared/platformDetection', () => ({
	isWindows: vi.fn(() => false),
}));

import { execFile } from 'child_process';
import { isWindows } from '../../../../shared/platformDetection';

const mockExecFile = vi.mocked(execFile);
const mockIsWindows = vi.mocked(isWindows);

describe('getChildProcesses', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockIsWindows.mockReturnValue(false);
	});

	it('returns empty array when pgrep finds no children', async () => {
		// First call: ps --ppid fails (macOS)
		mockExecFile.mockImplementationOnce((_cmd, _args, _opts, cb: any) => {
			cb(new Error('not supported'), '', '');
			return {} as any;
		});
		// Second call: ps -o (fallback, also fails to trigger darwin path)
		mockExecFile.mockImplementationOnce((_cmd, _args, _opts, cb: any) => {
			cb(new Error('no match'), '', '');
			return {} as any;
		});
		// Third call: pgrep -P (darwin fallback, no children)
		mockExecFile.mockImplementationOnce((_cmd, _args, _opts, cb: any) => {
			cb(new Error('no children'), '', '');
			return {} as any;
		});

		const result = await getChildProcesses(12345);
		expect(result).toEqual([]);
	});

	it('parses pgrep + ps output on macOS (darwin fallback)', async () => {
		// First call: ps --ppid fails (macOS doesn't support --ppid)
		mockExecFile.mockImplementationOnce((_cmd, _args, _opts, cb: any) => {
			cb(new Error('not supported'), '', '');
			return {} as any;
		});
		// Second call: ps -o (fallback check, triggers darwin path)
		mockExecFile.mockImplementationOnce((_cmd, _args, _opts, cb: any) => {
			cb(null, '', '');
			return {} as any;
		});
		// Third call: pgrep -P returns child PIDs
		mockExecFile.mockImplementationOnce((_cmd, _args, _opts, cb: any) => {
			cb(null, '100\n200\n', '');
			return {} as any;
		});
		// Fourth call: ps -o pid=,comm= for those PIDs
		mockExecFile.mockImplementationOnce((_cmd, _args, _opts, cb: any) => {
			cb(null, '  100 node\n  200 python\n', '');
			return {} as any;
		});

		const result = await getChildProcesses(12345);
		expect(result).toEqual([
			{ pid: 100, command: 'node' },
			{ pid: 200, command: 'python' },
		]);
	});

	it('filters out shell processes from results', async () => {
		// ps --ppid fails → darwin fallback
		mockExecFile.mockImplementationOnce((_cmd, _args, _opts, cb: any) => {
			cb(new Error('not supported'), '', '');
			return {} as any;
		});
		mockExecFile.mockImplementationOnce((_cmd, _args, _opts, cb: any) => {
			cb(null, '', '');
			return {} as any;
		});
		// pgrep returns PIDs
		mockExecFile.mockImplementationOnce((_cmd, _args, _opts, cb: any) => {
			cb(null, '100\n200\n300\n', '');
			return {} as any;
		});
		// ps shows a mix of shell and non-shell processes
		mockExecFile.mockImplementationOnce((_cmd, _args, _opts, cb: any) => {
			cb(null, '  100 zsh\n  200 node\n  300 bash\n', '');
			return {} as any;
		});

		const result = await getChildProcesses(12345);
		// zsh and bash should be filtered out
		expect(result).toEqual([{ pid: 200, command: 'node' }]);
	});

	it('parses Linux ps --ppid output directly', async () => {
		// ps --ppid succeeds on Linux
		mockExecFile.mockImplementationOnce((_cmd, _args, _opts, cb: any) => {
			cb(null, '  500 npm\n  600 webpack\n', '');
			return {} as any;
		});

		const result = await getChildProcesses(12345);
		expect(result).toEqual([
			{ pid: 500, command: 'npm' },
			{ pid: 600, command: 'webpack' },
		]);
	});

	it('handles Windows with wmic', async () => {
		mockIsWindows.mockReturnValue(true);

		mockExecFile.mockImplementationOnce((_cmd, _args, _opts, cb: any) => {
			cb(null, 'Node,CommandLine,ProcessId\nHOST,node server.js,999\n', '');
			return {} as any;
		});

		const result = await getChildProcesses(12345);
		expect(result).toEqual([{ pid: 999, command: 'node server.js' }]);
	});

	it('returns empty array on error', async () => {
		mockIsWindows.mockReturnValue(true);

		mockExecFile.mockImplementationOnce((_cmd, _args, _opts, cb: any) => {
			cb(new Error('failed'), '', '');
			return {} as any;
		});

		const result = await getChildProcesses(12345);
		expect(result).toEqual([]);
	});
});
