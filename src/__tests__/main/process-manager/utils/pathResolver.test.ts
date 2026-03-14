import { describe, expect, it } from 'vitest';
import { buildInteractiveShellArgs } from '../../../../main/process-manager/utils/pathResolver';

describe('pathResolver', () => {
	describe('buildInteractiveShellArgs', () => {
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
