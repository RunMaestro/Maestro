import { describe, it, expect } from 'vitest';
import {
	agentCliLabel,
	agentNotInstalledMessage,
	classifyMissingBinary,
	getAgentInstallCommand,
	getAgentInstallInfo,
	toInstallPlatform,
} from '../../shared/agentInstall';
import { AGENT_IDS } from '../../shared/agentIds';

describe('agentInstall', () => {
	describe('getAgentInstallCommand', () => {
		it('returns the per-platform install for Codex', () => {
			expect(getAgentInstallCommand('codex', 'darwin')).toBe('npm install -g @openai/codex');
			expect(getAgentInstallCommand('codex', 'linux')).toBe('npm install -g @openai/codex');
			expect(getAgentInstallCommand('codex', 'win32')).toBe('npm install -g @openai/codex');
		});

		it('wraps PowerShell-only Windows installers so cmd.exe can run them too', () => {
			for (const id of AGENT_IDS) {
				const command = getAgentInstallCommand(id, 'win32');
				if (command && /\birm\b/.test(command)) {
					expect(command.startsWith('powershell ')).toBe(true);
				}
			}
		});

		it('returns null for agents without an install path and for unknown ids', () => {
			expect(getAgentInstallCommand('terminal', 'darwin')).toBeNull();
			expect(getAgentInstallCommand('qwen3-coder', 'darwin')).toBeNull();
			expect(getAgentInstallCommand('not-a-provider', 'darwin')).toBeNull();
		});

		it('returns null for a platform it has no command for', () => {
			expect(getAgentInstallCommand('codex', 'browser')).toBeNull();
			expect(getAgentInstallCommand('codex', '')).toBeNull();
		});

		it('keeps POSIX commands runnable in Fish as well as bash/zsh', () => {
			for (const id of AGENT_IDS) {
				for (const platform of ['darwin', 'linux'] as const) {
					const command = getAgentInstallCommand(id, platform);
					if (!command) continue;
					// `exit $?` is bash-only; Fish spells the last status `$status`.
					expect(command).not.toMatch(/\bexit\s+\$\?/);
				}
			}
		});
	});

	it('gives every installable agent a docs URL and all three platforms', () => {
		for (const id of AGENT_IDS) {
			const info = getAgentInstallInfo(id);
			if (!info) continue;
			expect(info.docsUrl).toMatch(/^https:\/\//);
			expect(Object.keys(info.commands).sort()).toEqual(['darwin', 'linux', 'win32']);
		}
	});

	it('narrows platform strings', () => {
		expect(toInstallPlatform('darwin')).toBe('darwin');
		expect(toInstallPlatform('win32')).toBe('win32');
		expect(toInstallPlatform('browser')).toBeNull();
	});

	describe('classifyMissingBinary', () => {
		it('treats a spawn ENOENT as not-found', () => {
			expect(classifyMissingBinary({ errorCode: 'ENOENT', command: 'codex' })).toBe('not-found');
			expect(classifyMissingBinary({ errorCode: 'ENOENT' })).toBe('not-found');
		});

		it('treats a shell exit 127 naming the launched command as not-found', () => {
			for (const stderr of [
				'zsh: command not found: codex',
				'sh: 1: codex: not found',
				'fish: Unknown command: codex',
			]) {
				expect(classifyMissingBinary({ exitCode: 127, stderr, command: 'codex' })).toBe(
					'not-found'
				);
			}
		});

		it('matches a launched path, extension, and case', () => {
			expect(
				classifyMissingBinary({
					exitCode: 127,
					stderr: 'zsh: command not found: codex',
					command: '/usr/local/bin/Codex.CMD',
				})
			).toBe('not-found');
		});

		it('does not blame the provider for a child command that is missing', () => {
			expect(
				classifyMissingBinary({
					exitCode: 127,
					stderr: 'sh: 1: git: not found',
					command: 'claude',
				})
			).toBeNull();
		});

		it('requires the launched command and stderr evidence for a 127', () => {
			expect(
				classifyMissingBinary({ exitCode: 127, stderr: 'zsh: command not found: codex' })
			).toBeNull();
			expect(classifyMissingBinary({ exitCode: 127, stderr: '', command: 'codex' })).toBeNull();
			expect(
				classifyMissingBinary({ exitCode: 127, stderr: 'Error: build failed', command: 'codex' })
			).toBeNull();
		});

		it('names a missing shebang runtime separately', () => {
			expect(
				classifyMissingBinary({
					exitCode: 127,
					stderr: 'env: node: No such file or directory',
					command: 'codex',
				})
			).toBe('runtime-missing');
		});

		it('accepts GNU env UTF-8 quotes around the runtime', () => {
			expect(
				classifyMissingBinary({
					exitCode: 127,
					stderr: '/usr/bin/env: ‘node’: No such file or directory',
					command: 'codex',
				})
			).toBe('runtime-missing');
		});

		it('requires a 127 for the runtime diagnostic, not just the wording', () => {
			expect(
				classifyMissingBinary({
					exitCode: 1,
					stderr: 'Tool output: env: node: No such file or directory',
					command: 'codex',
				})
			).toBeNull();
		});

		it('recognizes the Windows "not recognized" errors naming the launched command', () => {
			expect(
				classifyMissingBinary({
					exitCode: 9009,
					stderr: "'codex' is not recognized as an internal or external command,",
					command: 'codex.cmd',
				})
			).toBe('not-found');
			expect(
				classifyMissingBinary({
					exitCode: 1,
					stderr: "codex : The term 'codex' is not recognized as the name of a cmdlet, function",
					command: 'codex',
				})
			).toBe('not-found');
		});

		it('does not blame the provider for another Windows command', () => {
			expect(
				classifyMissingBinary({
					exitCode: 9009,
					stderr: "'git' is not recognized as an internal or external command,",
					command: 'codex',
				})
			).toBeNull();
		});

		it('requires the Windows wording on stderr, not just exit 1', () => {
			expect(classifyMissingBinary({ exitCode: 1, stderr: '', command: 'codex' })).toBeNull();
			expect(
				classifyMissingBinary({
					exitCode: 1,
					stderr: "'codex' is not recognized as an internal or external command,",
				})
			).toBeNull();
		});

		it('ignores ordinary failures', () => {
			expect(
				classifyMissingBinary({ exitCode: 1, stderr: 'Error: rate limited', command: 'codex' })
			).toBeNull();
			expect(classifyMissingBinary({ errorCode: 'EACCES' })).toBeNull();
			expect(classifyMissingBinary({ exitCode: 0 })).toBeNull();
		});
	});

	describe('messages', () => {
		it('names the provider CLI without doubling "CLI"', () => {
			expect(agentCliLabel('codex')).toBe('Codex CLI');
			expect(agentCliLabel('gemini-cli')).toBe('Gemini CLI');
			expect(agentCliLabel('copilot-cli')).toBe('Copilot-CLI');
		});

		it('says what is missing', () => {
			expect(agentNotInstalledMessage('codex', 'not-found')).toMatch(/^Codex CLI not installed\./);
			expect(agentNotInstalledMessage('codex', 'runtime-missing')).toMatch(/Node\.js/);
		});

		it('restores Node.js before suggesting a reinstall for a missing runtime', () => {
			const message = agentNotInstalledMessage('codex', 'runtime-missing', 'darwin');
			expect(message).toContain('Restore Node.js to PATH first');
			expect(message).toContain('Reinstall the CLI');
			expect(message).not.toContain('npm install');
		});

		it('prints the platform install command for the user to copy', () => {
			expect(agentNotInstalledMessage('codex', 'not-found', 'win32')).toContain(
				'npm install -g @openai/codex'
			);
			expect(agentNotInstalledMessage('claude-code', 'not-found', 'linux')).toContain(
				'curl -fsSL https://claude.ai/install.sh | bash'
			);
		});

		it('points at the provider guide when there is no command for the platform', () => {
			const message = agentNotInstalledMessage('codex', 'not-found');
			expect(message).not.toContain('npm install');
			expect(message).toContain('https://');
		});

		it('never invents a command for a provider with no install path', () => {
			const message = agentNotInstalledMessage('grok', 'not-found', 'darwin');
			expect(message).not.toContain('Install it with:');
			expect(message).toMatch(/install guide/);
		});
	});
});
