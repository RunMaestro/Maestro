/**
 * Tests for clean-playbooks CLI command.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExistsSync, mockReaddirSync, mockUnlinkSync } = vi.hoisted(() => ({
	mockExistsSync: vi.fn(),
	mockReaddirSync: vi.fn(),
	mockUnlinkSync: vi.fn(),
}));

vi.mock('fs', () => ({
	existsSync: (...args: unknown[]) => mockExistsSync(...args),
	readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
	unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
}));

const { mockReadSessions, mockGetConfigDirectory } = vi.hoisted(() => ({
	mockReadSessions: vi.fn(),
	mockGetConfigDirectory: vi.fn(),
}));

vi.mock('../../cli/services/storage', () => ({
	readSessions: (...args: unknown[]) => mockReadSessions(...args),
	getConfigDirectory: (...args: unknown[]) => mockGetConfigDirectory(...args),
}));

const { mockFormatError, mockFormatSuccess } = vi.hoisted(() => ({
	mockFormatError: vi.fn((message: string) => `Error: ${message}`),
	mockFormatSuccess: vi.fn((message: string) => `Success: ${message}`),
}));

vi.mock('../../cli/output/formatter', () => ({
	formatError: (...args: unknown[]) => mockFormatError(...args),
	formatSuccess: (...args: unknown[]) => mockFormatSuccess(...args),
}));

import { cleanPlaybooks } from '../../cli/commands/clean-playbooks';

describe('clean-playbooks command', () => {
	let consoleLog: ReturnType<typeof vi.spyOn>;
	let consoleError: ReturnType<typeof vi.spyOn>;
	let processExit: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExit = vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`process.exit(${code})`);
		});
		mockGetConfigDirectory.mockReturnValue('/config');
		mockExistsSync.mockReturnValue(true);
		mockReadSessions.mockReturnValue([{ id: 'session-a' }, { id: 'session-b' }]);
		mockReaddirSync.mockReturnValue(['session-a.json', 'orphan-one.json', 'notes.txt']);
	});

	afterEach(() => {
		consoleLog.mockRestore();
		consoleError.mockRestore();
		processExit.mockRestore();
	});

	it('prints a human-readable success when the playbooks directory is missing', () => {
		mockExistsSync.mockReturnValue(false);

		cleanPlaybooks({});

		expect(mockExistsSync).toHaveBeenCalledWith('/config/playbooks');
		expect(mockReadSessions).not.toHaveBeenCalled();
		expect(mockFormatSuccess).toHaveBeenCalledWith('No orphaned playbooks found');
		expect(consoleLog).toHaveBeenCalledWith('Success: No orphaned playbooks found');
	});

	it('prints JSON when no orphaned playbooks are found', () => {
		mockReaddirSync.mockReturnValue(['session-a.json', 'session-b.json']);

		cleanPlaybooks({ json: true });

		expect(JSON.parse(consoleLog.mock.calls[0][0])).toEqual({ removed: [], count: 0 });
	});

	it('treats ENOENT during directory reads as an empty orphan list', () => {
		const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
		mockReaddirSync.mockImplementationOnce(() => {
			throw enoent;
		});

		cleanPlaybooks({});

		expect(consoleLog).toHaveBeenCalledWith('Success: No orphaned playbooks found');
	});

	it('prints JSON dry-run details without deleting orphaned playbooks', () => {
		cleanPlaybooks({ json: true, dryRun: true });

		const output = JSON.parse(consoleLog.mock.calls[0][0]);
		expect(output).toEqual({
			dryRun: true,
			wouldRemove: [
				{
					sessionId: 'orphan-one',
					filePath: '/config/playbooks/orphan-one.json',
				},
			],
			count: 1,
		});
		expect(mockUnlinkSync).not.toHaveBeenCalled();
	});

	it('prints human-readable dry-run details for each orphan', () => {
		cleanPlaybooks({ dryRun: true });

		expect(consoleLog).toHaveBeenCalledWith('\nWould remove 1 orphaned playbook file(s):\n');
		expect(consoleLog).toHaveBeenCalledWith('  orphan-o  /config/playbooks/orphan-one.json');
		expect(consoleLog).toHaveBeenCalledWith(
			'\nRun without --dry-run to actually remove these files.'
		);
		expect(mockUnlinkSync).not.toHaveBeenCalled();
	});

	it('removes orphaned playbooks and reports partial delete failures in human-readable mode', () => {
		mockReaddirSync.mockReturnValue(['orphan-success.json', 'orphan-fail.json']);
		mockUnlinkSync.mockImplementation((filePath: string) => {
			if (filePath.includes('orphan-fail')) {
				throw new Error('permission denied');
			}
		});

		cleanPlaybooks({});

		expect(mockUnlinkSync).toHaveBeenCalledWith('/config/playbooks/orphan-success.json');
		expect(mockUnlinkSync).toHaveBeenCalledWith('/config/playbooks/orphan-fail.json');
		expect(consoleError).toHaveBeenCalledWith(
			'Failed to remove /config/playbooks/orphan-fail.json: Error: permission denied'
		);
		expect(mockFormatSuccess).toHaveBeenCalledWith('Removed 1 orphaned playbook file(s)');
		expect(consoleLog).toHaveBeenCalledWith('  orphan-s');
	});

	it('prints removed orphan IDs as JSON with shortened IDs', () => {
		mockReaddirSync.mockReturnValue(['orphan-success.json']);

		cleanPlaybooks({ json: true });

		expect(mockUnlinkSync).toHaveBeenCalledWith('/config/playbooks/orphan-success.json');
		expect(JSON.parse(consoleLog.mock.calls[0][0])).toEqual({
			removed: ['orphan-s'],
			count: 1,
		});
	});

	it('prints formatted fatal errors and exits in human-readable mode', () => {
		mockReadSessions.mockImplementationOnce(() => {
			throw new Error('storage unavailable');
		});

		expect(() => cleanPlaybooks({})).toThrow('process.exit(1)');

		expect(mockFormatError).toHaveBeenCalledWith('Failed to clean playbooks: storage unavailable');
		expect(consoleError).toHaveBeenCalledWith(
			'Error: Failed to clean playbooks: storage unavailable'
		);
		expect(processExit).toHaveBeenCalledWith(1);
	});

	it('prints JSON fatal errors with Unknown error for non-Error throws', () => {
		mockReadSessions.mockImplementationOnce(() => {
			throw 'bad storage';
		});

		expect(() => cleanPlaybooks({ json: true })).toThrow('process.exit(1)');

		expect(JSON.parse(consoleError.mock.calls[0][0])).toEqual({ error: 'Unknown error' });
		expect(processExit).toHaveBeenCalledWith(1);
	});
});
