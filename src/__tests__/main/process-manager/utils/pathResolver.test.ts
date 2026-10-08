import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildInteractiveShellArgs } from '../../../../main/process-manager/utils/pathResolver';

describe('pathResolver', () => {
	describe('buildInteractiveShellArgs', () => {
		// These assertions model the Unix shell branch. `platformDetection`
		// reads `process.platform` first, so force it to a Unix value; otherwise
		// on Windows the product's `isWindows()` early-return yields `[command]`.
		const originalPlatform = process.platform;
		beforeEach(() => {
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
		});
		afterEach(() => {
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
		});

		it('uses login + interactive flags for zsh commands', () => {
			expect(buildInteractiveShellArgs('ls', 'zsh')).toEqual(['-l', '-i', '-c', 'ls']);
		});

		it('passes the command as a dedicated shell argument without manual quoting', () => {
			expect(buildInteractiveShellArgs("printf 'hi'", 'zsh')).toEqual([
				'-l',
				'-i',
				'-c',
				"printf 'hi'",
			]);
		});

		it('uses login + interactive flags for bash commands', () => {
			expect(buildInteractiveShellArgs('ls', 'bash')).toEqual(['-l', '-i', '-c', 'ls']);
		});
	});
});
