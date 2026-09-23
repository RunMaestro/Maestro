import { describe, it, expect } from 'vitest';
import {
	detectNonPosixRemoteShell,
	nonPosixRemoteShellMessage,
	nonPosixRemoteShellName,
	nonPosixRemoteShellRemediation,
} from '../../shared/sshRemoteShell';
import { getSshErrorPatterns, matchErrorPattern } from '../../shared/agentErrorPatterns';

describe('detectNonPosixRemoteShell', () => {
	it('identifies the PowerShell 5.1 rejection of &&', () => {
		expect(
			detectNonPosixRemoteShell(
				"The token '&&' is not a valid statement separator in this version."
			)
		).toBe('powershell');
	});

	it('identifies a bare PowerShell error record', () => {
		expect(detectNonPosixRemoteShell('+ FullyQualifiedErrorId : InvalidEndOfLine')).toBe(
			'powershell'
		);
	});

	it('identifies PowerShell failing to find /bin/bash', () => {
		expect(
			detectNonPosixRemoteShell(
				"The term '/bin/bash' is not recognized as the name of a cmdlet, function, script file, or operable program."
			)
		).toBe('powershell');
	});

	it('identifies cmd.exe syntax complaints', () => {
		expect(detectNonPosixRemoteShell('hostname was unexpected at this time.')).toBe('cmd');
	});

	it('identifies cmd.exe failing to find /bin/bash', () => {
		expect(
			detectNonPosixRemoteShell(
				"'/bin/bash' is not recognized as an internal or external command, operable program or batch file."
			)
		).toBe('cmd');
	});

	it('leaves ordinary SSH failures alone', () => {
		expect(detectNonPosixRemoteShell('Permission denied (publickey).')).toBeUndefined();
		expect(detectNonPosixRemoteShell('bash: claude: command not found')).toBeUndefined();
		expect(detectNonPosixRemoteShell('')).toBeUndefined();
	});
});

describe('nonPosixRemoteShellRemediation', () => {
	it('names the host and the shell, and hands over a fix command', () => {
		const remediation = nonPosixRemoteShellRemediation('powershell', 'PEDSIM');

		expect(remediation.code).toBe('non-posix-remote-shell');
		expect(remediation.title).toContain('Windows PowerShell');
		expect(remediation.detail).toContain('PEDSIM');
		expect(remediation.command).toContain('DefaultShell');
		expect(remediation.command).toContain('bash.exe');
		expect(remediation.docsUrl).toContain('windows-remote-hosts');
	});

	it('stays readable when no hostname was recovered', () => {
		const remediation = nonPosixRemoteShellRemediation('cmd');

		expect(remediation.detail).toContain('The remote answers');
		expect(remediation.detail).toContain('cmd.exe');
	});

	it('flattens to the same prose for surfaces with no panel', () => {
		expect(nonPosixRemoteShellMessage('cmd', 'WINBOX')).toBe(
			nonPosixRemoteShellRemediation('cmd', 'WINBOX').detail
		);
	});

	it('names each shell family', () => {
		expect(nonPosixRemoteShellName('powershell')).toBe('Windows PowerShell');
		expect(nonPosixRemoteShellName('cmd')).toBe('cmd.exe');
	});
});

describe('SSH error patterns for a Windows remote', () => {
	// A run against a Windows remote dies inside the agent process, not in the
	// connection test, so the streaming bank has to recognize it too.
	const patterns = getSshErrorPatterns();

	it('classifies PowerShell rejecting /bin/bash as a crash with the shell fix', () => {
		const match = matchErrorPattern(
			patterns,
			"The term '/bin/bash' is not recognized as the name of a cmdlet, function, script file, or operable program."
		);

		expect(match?.type).toBe('agent_crashed');
		expect(match?.message).toContain('DefaultShell');
		expect(match?.recoverable).toBe(false);
	});

	it('classifies cmd.exe rejecting /bin/bash the same way', () => {
		const match = matchErrorPattern(
			patterns,
			"'/bin/bash' is not recognized as an internal or external command, operable program or batch file."
		);

		expect(match?.type).toBe('agent_crashed');
		expect(match?.message).toContain('DefaultShell');
	});

	it('does not claim a POSIX command-not-found is a Windows shell', () => {
		const match = matchErrorPattern(patterns, 'bash: claude: command not found');

		expect(match?.message).not.toContain('DefaultShell');
	});
});
