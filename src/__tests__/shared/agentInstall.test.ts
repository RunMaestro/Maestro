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
			expect(classifyMissingBinary({ errorCode: 'ENOENT' })).toBe('not-found');
		});

		it('treats a shell exit 127 as not-found', () => {
			expect(
				classifyMissingBinary({ exitCode: 127, stderr: 'zsh: command not found: codex' })
			).toBe('not-found');
		});

		it('names a missing shebang runtime separately', () => {
			expect(
				classifyMissingBinary({ exitCode: 127, stderr: 'env: node: No such file or directory' })
			).toBe('runtime-missing');
		});

		it('recognizes the Windows "not recognized" errors', () => {
			expect(
				classifyMissingBinary({
					exitCode: 9009,
					stderr: "'codex' is not recognized as an internal or external command,",
				})
			).toBe('not-found');
			expect(
				classifyMissingBinary({
					exitCode: 1,
					stderr: "codex : The term 'codex' is not recognized as the name of a cmdlet, function",
				})
			).toBe('not-found');
		});

		it('ignores ordinary failures', () => {
			expect(classifyMissingBinary({ exitCode: 1, stderr: 'Error: rate limited' })).toBeNull();
			expect(classifyMissingBinary({ errorCode: 'EACCES' })).toBeNull();
			expect(classifyMissingBinary({ exitCode: 0 })).toBeNull();
		});

		it('requires the Windows wording on stderr, not just exit 1', () => {
			expect(classifyMissingBinary({ exitCode: 1, stderr: '' })).toBeNull();
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
	});
});
