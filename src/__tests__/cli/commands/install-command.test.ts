/**
 * Tests for `maestro-cli install-command <provider>`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installCommand } from '../../../cli/commands/install-command';
import { ExitCode } from '../../../cli/exit-codes';

describe('installCommand', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let exitSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
			throw new Error(`process.exit(${code})`);
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('prints the install command for the requested platform', () => {
		installCommand('codex', { platform: 'linux' });
		expect(logSpy).toHaveBeenCalledWith('npm install -g @openai/codex');

		logSpy.mockClear();
		installCommand('claude-code', { platform: 'win32' });
		expect(logSpy).toHaveBeenCalledWith(
			'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"'
		);

		logSpy.mockClear();
		installCommand('claude-code', { platform: 'darwin' });
		expect(logSpy).toHaveBeenCalledWith('curl -fsSL https://claude.ai/install.sh | bash');
	});

	it('defaults to process.platform when --platform is omitted', () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
		try {
			installCommand('codex', {});
			expect(logSpy).toHaveBeenCalledWith('npm install -g @openai/codex');
		} finally {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
		}
	});

	it('outputs structured JSON with --json', () => {
		installCommand('codex', { platform: 'darwin', json: true });

		expect(logSpy).toHaveBeenCalledTimes(1);
		const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
		expect(parsed).toEqual({
			provider: 'codex',
			name: 'Codex',
			platform: 'darwin',
			command: 'npm install -g @openai/codex',
			docsUrl: 'https://github.com/openai/codex#installing-and-running-codex-cli',
		});
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('exits with GeneralError when a provider has no one-line install', () => {
		expect(() => installCommand('antigravity', { platform: 'linux' })).toThrow(
			`process.exit(${ExitCode.GeneralError})`
		);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No one-line install'));
	});

	it('outputs JSON with null command and exits with GeneralError when no install exists', () => {
		expect(() => installCommand('antigravity', { platform: 'linux', json: true })).toThrow(
			`process.exit(${ExitCode.GeneralError})`
		);
		const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
		expect(parsed).toEqual({
			provider: 'antigravity',
			name: 'Antigravity CLI',
			platform: 'linux',
			command: null,
			docsUrl: null,
		});
	});

	it('exits with InvalidUsage for an unsupported platform', () => {
		expect(() => installCommand('codex', { platform: 'freebsd' })).toThrow(
			`process.exit(${ExitCode.InvalidUsage})`
		);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unsupported platform'));
	});

	it('exits with InvalidUsage for an unknown provider', () => {
		expect(() => installCommand('nonexistent-cli', { platform: 'linux' })).toThrow(
			`process.exit(${ExitCode.InvalidUsage})`
		);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unknown provider'));
	});
});
