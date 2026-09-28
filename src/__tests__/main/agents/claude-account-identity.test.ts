/**
 * Tests for src/main/agents/claude-account-identity.ts
 *
 * The reader's whole contract is "never throw, degrade to null" - the account
 * email is a labeling nicety, and no failure here may cost a usage sample. So
 * these cover the read path plus every way `.claude.json` can let us down.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { readFileMock, loggerWarnMock } = vi.hoisted(() => ({
	readFileMock: vi.fn(),
	loggerWarnMock: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	const promises = { ...actual.promises, readFile: readFileMock };
	return { ...actual, promises, default: { ...actual, promises } };
});

vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: loggerWarnMock, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import path from 'path';
import { readClaudeAccountIdentity } from '../../../main/agents/claude-account-identity';

beforeEach(() => {
	readFileMock.mockReset();
	loggerWarnMock.mockReset();
});

describe('readClaudeAccountIdentity', () => {
	it('reads .claude.json from the config dir and returns the account identity', async () => {
		readFileMock.mockResolvedValue(
			JSON.stringify({
				oauthAccount: {
					accountUuid: '8d3c60a2-9638-49e7-95ff-45813e8b35d8',
					emailAddress: 'pedram@banaco.com',
					organizationName: "pedram@banaco.com's Organization",
				},
			})
		);

		const identity = await readClaudeAccountIdentity('/Users/test/.claude-banaco');

		expect(readFileMock).toHaveBeenCalledWith(
			path.join('/Users/test/.claude-banaco', '.claude.json'),
			'utf8'
		);
		expect(identity).toEqual({
			accountUuid: '8d3c60a2-9638-49e7-95ff-45813e8b35d8',
			email: 'pedram@banaco.com',
			organizationName: "pedram@banaco.com's Organization",
		});
	});

	it('returns null without logging when the file does not exist', async () => {
		// A config dir that was never logged into is ordinary, not an error.
		readFileMock.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }));

		expect(await readClaudeAccountIdentity('/Users/test/.claude-fresh')).toBeNull();
		expect(loggerWarnMock).not.toHaveBeenCalled();
	});

	it('returns null and warns when the file is not valid JSON', async () => {
		readFileMock.mockResolvedValue('{ this is not json');

		expect(await readClaudeAccountIdentity('/Users/test/.claude')).toBeNull();
		expect(loggerWarnMock).toHaveBeenCalledWith(
			expect.stringContaining('Failed to parse'),
			expect.any(String),
			expect.objectContaining({ configPath: path.join('/Users/test/.claude', '.claude.json') })
		);
	});

	it('returns null when the JSON carries no oauthAccount', async () => {
		readFileMock.mockResolvedValue(JSON.stringify({ userID: 'abc', projects: {} }));

		expect(await readClaudeAccountIdentity('/Users/test/.claude')).toBeNull();
		expect(loggerWarnMock).not.toHaveBeenCalled();
	});

	it('does not throw when the read rejects for a non-ENOENT reason', async () => {
		readFileMock.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));

		await expect(readClaudeAccountIdentity('/Users/test/.claude')).resolves.toBeNull();
	});
});
