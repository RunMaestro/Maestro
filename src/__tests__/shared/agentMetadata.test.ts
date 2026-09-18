/**
 * Tests for shared/agentMetadata.ts - Display names and classification sets
 */

import { describe, it, expect } from 'vitest';
import {
	getAgentDisplayName,
	isBetaAgent,
	getAgentLoginCommand,
	getReadOnlyModeLabel,
	getReadOnlyModeTooltip,
	getPermissionModeLabel,
	getPermissionModeTooltip,
	resolveTabPermissionMode,
	formatAgentLoginCommand,
	loginShellSyntaxFor,
	AGENT_DISPLAY_NAMES,
	BETA_AGENTS,
} from '../../shared/agentMetadata';
import { AGENT_IDS } from '../../shared/agentIds';

describe('agentMetadata', () => {
	describe('getAgentDisplayName', () => {
		it('should return a non-empty display name for every agent in AGENT_IDS', () => {
			for (const id of AGENT_IDS) {
				const name = getAgentDisplayName(id);
				expect(typeof name).toBe('string');
				expect(name.length).toBeGreaterThan(0);
			}
		});

		it('should return correct names for known agents', () => {
			expect(AGENT_DISPLAY_NAMES['claude-code']).toBe('Claude Code');
			expect(AGENT_DISPLAY_NAMES['codex']).toBe('Codex');
			expect(AGENT_DISPLAY_NAMES['opencode']).toBe('OpenCode');
			expect(AGENT_DISPLAY_NAMES['factory-droid']).toBe('Factory Droid');
			expect(AGENT_DISPLAY_NAMES['hermes']).toBe('Hermes');
			expect(AGENT_DISPLAY_NAMES['pi']).toBe('Pi');
			expect(AGENT_DISPLAY_NAMES['gemini-cli']).toBe('Gemini CLI');
			expect(AGENT_DISPLAY_NAMES['qwen3-coder']).toBe('Qwen3 Coder');
			expect(AGENT_DISPLAY_NAMES['copilot-cli']).toBe('Copilot-CLI');
			expect(AGENT_DISPLAY_NAMES['omp']).toBe('Oh My Pi');
			expect(AGENT_DISPLAY_NAMES['terminal']).toBe('Terminal');
		});

		it('should not have entries for unknown agents', () => {
			// TypeScript would prevent this at compile time, but runtime check for safety
			expect((AGENT_DISPLAY_NAMES as Record<string, string>)['unknown']).toBeUndefined();
		});

		it('should work for all AGENT_IDS entries', () => {
			for (const id of AGENT_IDS) {
				const name = getAgentDisplayName(id);
				expect(name).toBe(AGENT_DISPLAY_NAMES[id]);
			}
		});
		it('should return display name for valid agent IDs', () => {
			expect(getAgentDisplayName('claude-code')).toBe('Claude Code');
			expect(getAgentDisplayName('codex')).toBe('Codex');
			expect(getAgentDisplayName('opencode')).toBe('OpenCode');
			expect(getAgentDisplayName('factory-droid')).toBe('Factory Droid');
			expect(getAgentDisplayName('gemini-cli')).toBe('Gemini CLI');
			expect(getAgentDisplayName('qwen3-coder')).toBe('Qwen3 Coder');
			expect(getAgentDisplayName('terminal')).toBe('Terminal');
		});

		it('should return the raw id for unknown agents as fallback', () => {
			expect(getAgentDisplayName('unknown-agent')).toBe('unknown-agent');
			expect(getAgentDisplayName('')).toBe('');
		});

		it('should not match Object.prototype keys like toString or constructor', () => {
			expect(getAgentDisplayName('toString')).toBe('toString');
			expect(getAgentDisplayName('constructor')).toBe('constructor');
			expect(getAgentDisplayName('hasOwnProperty')).toBe('hasOwnProperty');
			expect(getAgentDisplayName('valueOf')).toBe('valueOf');
		});
	});

	describe('BETA_AGENTS', () => {
		it('should be a ReadonlySet', () => {
			expect(BETA_AGENTS).toBeInstanceOf(Set);
		});

		it('should contain the expected beta agents', () => {
			expect(BETA_AGENTS.has('opencode')).toBe(true);
			expect(BETA_AGENTS.has('factory-droid')).toBe(true);
			expect(BETA_AGENTS.has('hermes')).toBe(true);
			expect(BETA_AGENTS.has('pi')).toBe(true);
			expect(BETA_AGENTS.has('copilot-cli')).toBe(true);
			expect(BETA_AGENTS.has('qwen3-coder')).toBe(true);
			expect(BETA_AGENTS.has('omp')).toBe(true);
		});

		it('should not contain non-beta agents', () => {
			expect(BETA_AGENTS.has('codex')).toBe(false);
			expect(BETA_AGENTS.has('claude-code')).toBe(false);
			expect(BETA_AGENTS.has('terminal')).toBe(false);
			expect(BETA_AGENTS.has('gemini-cli')).toBe(false);
		});

		it('should only contain valid agent IDs', () => {
			for (const id of BETA_AGENTS) {
				expect(AGENT_IDS).toContain(id);
			}
		});
	});

	describe('isBetaAgent', () => {
		it('should return true for beta agents', () => {
			expect(isBetaAgent('opencode')).toBe(true);
			expect(isBetaAgent('factory-droid')).toBe(true);
			expect(isBetaAgent('hermes')).toBe(true);
			expect(isBetaAgent('pi')).toBe(true);
			expect(isBetaAgent('copilot-cli')).toBe(true);
			expect(isBetaAgent('qwen3-coder')).toBe(true);
			expect(isBetaAgent('omp')).toBe(true);
		});

		it('should return false for non-beta agents', () => {
			expect(isBetaAgent('claude-code')).toBe(false);
			expect(isBetaAgent('codex')).toBe(false);
			expect(isBetaAgent('terminal')).toBe(false);
			expect(isBetaAgent('gemini-cli')).toBe(false);
		});

		it('should return false for unknown agents', () => {
			expect(isBetaAgent('unknown-agent')).toBe(false);
			expect(isBetaAgent('')).toBe(false);
		});

		it('should produce a stable boolean for every known AGENT_ID', () => {
			for (const id of AGENT_IDS) {
				expect(typeof isBetaAgent(id)).toBe('boolean');
			}
		});
	});

	describe('getReadOnlyModeLabel', () => {
		it('should return "Plan-Mode" for agents that use plan mode', () => {
			expect(getReadOnlyModeLabel('claude-code')).toBe('Plan-Mode');
			expect(getReadOnlyModeLabel('opencode')).toBe('Plan-Mode');
		});

		it('should return "Read-Only" for agents with true read-only enforcement', () => {
			expect(getReadOnlyModeLabel('codex')).toBe('Read-Only');
			expect(getReadOnlyModeLabel('factory-droid')).toBe('Read-Only');
		});

		it('should return "Read-Only" for unknown agents', () => {
			expect(getReadOnlyModeLabel('unknown-agent')).toBe('Read-Only');
		});
	});

	describe('getReadOnlyModeTooltip', () => {
		it('should return plan mode tooltip for plan mode agents', () => {
			expect(getReadOnlyModeTooltip('claude-code')).toContain('plan mode');
			expect(getReadOnlyModeTooltip('opencode')).toContain('plan mode');
		});

		it('should return read-only tooltip for other agents', () => {
			expect(getReadOnlyModeTooltip('codex')).toContain('Read-Only');
			expect(getReadOnlyModeTooltip('factory-droid')).toContain('Read-Only');
		});
	});

	describe('getPermissionModeLabel', () => {
		it('should return "Full Access" for full mode regardless of agent', () => {
			expect(getPermissionModeLabel('full')).toBe('Full Access');
			expect(getPermissionModeLabel('full', 'claude-code')).toBe('Full Access');
		});

		it('should return "Standard" for standard mode regardless of agent', () => {
			expect(getPermissionModeLabel('standard')).toBe('Standard');
			expect(getPermissionModeLabel('standard', 'claude-code')).toBe('Standard');
		});

		it('should return "Read Only" for readonly mode when no agentId is given', () => {
			expect(getPermissionModeLabel('readonly')).toBe('Read Only');
		});

		it('should delegate to getReadOnlyModeLabel for readonly mode when agentId is given', () => {
			expect(getPermissionModeLabel('readonly', 'claude-code')).toBe('Plan-Mode');
			expect(getPermissionModeLabel('readonly', 'codex')).toBe('Read-Only');
			expect(getPermissionModeLabel('readonly', 'factory-droid')).toBe('Read-Only');
		});
	});

	describe('getPermissionModeTooltip', () => {
		it('should return the generic full access tooltip regardless of agent', () => {
			expect(getPermissionModeTooltip('full')).toContain('Full Access');
			expect(getPermissionModeTooltip('full', 'claude-code')).toContain('Full Access');
		});

		it('should return the generic standard tooltip regardless of agent', () => {
			expect(getPermissionModeTooltip('standard')).toContain('Standard');
			expect(getPermissionModeTooltip('standard', 'claude-code')).toContain('Standard');
		});

		it('should return the generic readonly tooltip when no agentId is given', () => {
			expect(getPermissionModeTooltip('readonly')).toContain('Read Only');
		});

		it('should delegate to getReadOnlyModeTooltip for readonly mode when agentId is given', () => {
			expect(getPermissionModeTooltip('readonly', 'claude-code')).toContain('plan mode');
			expect(getPermissionModeTooltip('readonly', 'codex')).toContain('Read-Only');
			expect(getPermissionModeTooltip('readonly', 'factory-droid')).toContain('Read-Only');
		});
	});

	describe('resolveTabPermissionMode', () => {
		it('treats a nullish tab as full access', () => {
			expect(resolveTabPermissionMode(undefined)).toBe('full');
			expect(resolveTabPermissionMode(null)).toBe('full');
		});

		it('treats a tab with no stored permissionMode as full access', () => {
			expect(resolveTabPermissionMode({})).toBe('full');
		});

		it('falls back to readonly only when the legacy readOnlyMode boolean is set', () => {
			expect(resolveTabPermissionMode({ readOnlyMode: true })).toBe('readonly');
			expect(resolveTabPermissionMode({ readOnlyMode: false })).toBe('full');
		});

		it('passes an explicit permissionMode through unchanged', () => {
			expect(resolveTabPermissionMode({ permissionMode: 'full' })).toBe('full');
			expect(resolveTabPermissionMode({ permissionMode: 'standard' })).toBe('standard');
			expect(resolveTabPermissionMode({ permissionMode: 'readonly' })).toBe('readonly');
		});

		it('prefers an explicit permissionMode over the legacy readOnlyMode boolean', () => {
			expect(resolveTabPermissionMode({ permissionMode: 'full', readOnlyMode: true })).toBe('full');
		});
	});

	describe('getAgentLoginCommand', () => {
		it('knows the login flow for every agent that has one', () => {
			// hermes, pi, and omp have no documented CLI login flow, and the
			// terminal agent is a plain shell - all four are deliberately null.
			const noLoginFlow = new Set(['terminal', 'hermes', 'pi', 'omp']);
			for (const id of AGENT_IDS) {
				const login = getAgentLoginCommand(id);
				if (noLoginFlow.has(id)) {
					expect(login, `${id} should have no login command`).toBeNull();
					continue;
				}
				expect(login, `no login command for ${id}`).not.toBeNull();
				expect(login!.binary.length).toBeGreaterThan(0);
			}
		});

		it('returns null for the terminal agent and for unknown ids', () => {
			expect(getAgentLoginCommand('terminal')).toBeNull();
			expect(getAgentLoginCommand('not-an-agent')).toBeNull();
		});

		it('substitutes a configured custom binary path', () => {
			const login = getAgentLoginCommand('claude-code', '/opt/tools/claude');
			expect(login?.binary).toBe('/opt/tools/claude');
			expect(login?.args).toBe('/login');
		});

		it('ignores a blank custom path', () => {
			expect(getAgentLoginCommand('codex', '   ')?.binary).toBe('codex');
		});

		it('flags agents whose login only exists as a slash command in their TUI', () => {
			expect(getAgentLoginCommand('factory-droid')?.followUp).toBe('/login');
			expect(getAgentLoginCommand('claude-code')?.followUp).toBeUndefined();
		});
	});

	describe('formatAgentLoginCommand', () => {
		it('joins the binary and its args', () => {
			expect(formatAgentLoginCommand({ binary: 'codex', args: 'login' })).toBe('codex login');
		});

		it('emits the bare binary when there are no args', () => {
			expect(formatAgentLoginCommand({ binary: 'droid', args: '' })).toBe('droid');
		});

		it('quotes a path containing spaces so the shell still runs it', () => {
			expect(formatAgentLoginCommand({ binary: '/Apps/My Tools/claude', args: '/login' })).toBe(
				'"/Apps/My Tools/claude" /login'
			);
		});
	});
	describe('Windows shell dialects', () => {
		// PowerShell parses a line STARTING with a quoted string as an expression
		// and echoes it, so a quoted path runs nothing. `&` is what makes it a
		// command. Agents installing under C:\Program Files makes this the
		// common Windows case, not an edge case.
		it('prefixes the call operator for a quoted path in PowerShell', () => {
			expect(
				formatAgentLoginCommand(
					{ binary: 'C:\\Program Files\\Claude\\claude.exe', args: '/login' },
					'powershell'
				)
			).toBe('& "C:\\Program Files\\Claude\\claude.exe" /login');
		});

		it('does not add the call operator when no quoting was needed', () => {
			expect(formatAgentLoginCommand({ binary: 'claude', args: '/login' }, 'powershell')).toBe(
				'claude /login'
			);
		});

		// cmd.exe runs a quoted path directly, so adding `&` there would break it.
		it('leaves cmd.exe quoting alone', () => {
			expect(
				formatAgentLoginCommand({ binary: 'C:\\Program Files\\c.exe', args: 'login' }, 'cmd')
			).toBe('"C:\\Program Files\\c.exe" login');
		});

		it('defaults to posix so macOS and Linux are unchanged', () => {
			const login = { binary: '/Apps/My Tools/claude', args: '/login' };
			expect(formatAgentLoginCommand(login)).toBe(formatAgentLoginCommand(login, 'posix'));
			expect(formatAgentLoginCommand(login)).toBe('"/Apps/My Tools/claude" /login');
		});
	});

	describe('loginShellSyntaxFor', () => {
		it('treats every shell as posix off Windows', () => {
			for (const shell of ['zsh', 'bash', 'fish', 'powershell']) {
				expect(loginShellSyntaxFor(shell, false)).toBe('posix');
			}
		});

		it('maps the Windows shell ids to their dialects', () => {
			expect(loginShellSyntaxFor('powershell', true)).toBe('powershell');
			expect(loginShellSyntaxFor('pwsh', true)).toBe('powershell');
			expect(loginShellSyntaxFor('cmd', true)).toBe('cmd');
		});

		// Git Bash and WSL run a posix shell even though the host is Windows.
		it('treats Git Bash and WSL as posix', () => {
			expect(loginShellSyntaxFor('bash', true)).toBe('posix');
			expect(loginShellSyntaxFor('wsl', true)).toBe('posix');
		});

		it('falls back to PowerShell for an unset or unknown Windows shell', () => {
			expect(loginShellSyntaxFor('', true)).toBe('powershell');
			expect(loginShellSyntaxFor('nushell', true)).toBe('powershell');
		});

		it('is not case or whitespace sensitive', () => {
			expect(loginShellSyntaxFor('  WSL  ', true)).toBe('posix');
			expect(loginShellSyntaxFor('CMD', true)).toBe('cmd');
		});
	});
});
