/**
 * OpenClaude integration tests.
 *
 * OpenClaude is a fork of Claude Code, and the whole integration is built on
 * that: the parser and the session storage are subclasses, and the error
 * patterns are shared outright. These tests pin the parity that makes that
 * safe, so a future change to Claude Code that should have carried over to
 * OpenClaude fails here instead of silently leaving the fork behind.
 *
 * They also pin the places the fork must NOT inherit - the `~/.claude` home,
 * project memory, and the permission relay - because those are the ones where
 * "it's the same CLI" quietly stops being true.
 */

import { describe, it, expect } from 'vitest';
import { AGENT_DEFINITIONS, AGENT_CAPABILITIES } from '../../../main/agents';
import { AGENT_IDS } from '../../../shared/agentIds';
import {
	AGENT_DISPLAY_NAMES,
	AGENT_PICKER_META,
	PICKABLE_AGENT_IDS,
	getAgentLoginCommand,
	isBetaAgent,
	getReadOnlyModeLabel,
} from '../../../shared/agentMetadata';
import { DEFAULT_CONTEXT_WINDOWS } from '../../../shared/agentConstants';
import { createOutputParser } from '../../../main/parsers/parser-factory';
import {
	getErrorPatterns,
	getSshErrorPatterns,
	matchSshErrorPattern,
} from '../../../main/parsers/error-patterns';
import { ClaudeSessionStorage } from '../../../main/storage/claude-session-storage';
import { OpenClaudeSessionStorage } from '../../../main/storage/openclaude-session-storage';

const openclaudeDef = AGENT_DEFINITIONS.find((def) => def.id === 'openclaude');
const claudeDef = AGENT_DEFINITIONS.find((def) => def.id === 'claude-code');

describe('OpenClaude agent', () => {
	describe('registration', () => {
		it('is a known agent id', () => {
			expect(AGENT_IDS).toContain('openclaude');
		});

		it('has a definition and a display name', () => {
			expect(openclaudeDef).toBeDefined();
			expect(AGENT_DISPLAY_NAMES.openclaude).toBe('OpenClaude');
		});

		it('is offered in the provider pickers and flagged beta', () => {
			expect(AGENT_PICKER_META.openclaude).not.toBeNull();
			expect(PICKABLE_AGENT_IDS).toContain('openclaude');
			expect(isBetaAgent('openclaude')).toBe(true);
		});

		it('uses plan-mode wording, like Claude Code', () => {
			expect(getReadOnlyModeLabel('openclaude')).toBe(getReadOnlyModeLabel('claude-code'));
			expect(getReadOnlyModeLabel('openclaude')).toBe('Plan-Mode');
		});

		it('has a default context window', () => {
			expect(DEFAULT_CONTEXT_WINDOWS.openclaude).toBeGreaterThan(0);
		});

		it('points re-auth at its own binary, not the claude one', () => {
			const login = getAgentLoginCommand('openclaude');
			expect(login?.binary).toBe('openclaude');
			// `/provider` is the guided setup for the backends it actually runs on;
			// `auth login` would only cover the first-party Anthropic route.
			expect(login?.followUp).toBe('/provider');
		});
	});

	describe('definition', () => {
		it('drives the openclaude binary', () => {
			expect(openclaudeDef?.command).toBe('openclaude');
			expect(openclaudeDef?.binaryName).toBe('openclaude');
		});

		it('shares the Claude Code headless CLI surface', () => {
			expect(openclaudeDef?.args).toEqual(claudeDef?.args);
			expect(openclaudeDef?.fullAccessArgs).toEqual(claudeDef?.fullAccessArgs);
			expect(openclaudeDef?.readOnlyArgs).toEqual(claudeDef?.readOnlyArgs);
			expect(openclaudeDef?.readOnlyCliEnforced).toBe(claudeDef?.readOnlyCliEnforced);
			expect(openclaudeDef?.noToolsArgs).toEqual(claudeDef?.noToolsArgs);
			expect(openclaudeDef?.resumeArgs?.('abc')).toEqual(claudeDef?.resumeArgs?.('abc'));
			expect(openclaudeDef?.modelArgs?.('gpt-4o')).toEqual(claudeDef?.modelArgs?.('gpt-4o'));
		});

		it('grants additional directories the same way Claude Code does', () => {
			const dirs = [{ path: '/tmp/scratch', access: 'read-write' as const }];
			expect(openclaudeDef?.additionalDirArgs?.(dirs)).toEqual(
				claudeDef?.additionalDirArgs?.(dirs)
			);
			// The completeness suite asserts this for every agent; repeated here
			// because a bare `--add-dir` would eat the next arg, which is the prompt.
			expect(openclaudeDef?.additionalDirArgs?.([])).toEqual([]);
		});

		it('does not inherit the maestro-p interactive path', () => {
			// `maestro-p` drives the real Claude TUI, which is a different binary.
			expect(openclaudeDef?.interactiveCommand).toBeUndefined();
		});

		it('does not inherit Claude Code’s env defaults', () => {
			// CLAUDE_CODE_DISABLE_BACKGROUND_TASKS is a Claude Code knob; setting it
			// on a fork that may not read it is noise at best.
			expect(openclaudeDef?.defaultEnvVars).toBeUndefined();
		});
	});

	describe('capabilities', () => {
		it('advertises the stream-json feature set', () => {
			const caps = AGENT_CAPABILITIES.openclaude;
			expect(caps.supportsJsonOutput).toBe(true);
			expect(caps.supportsSessionId).toBe(true);
			expect(caps.supportsResume).toBe(true);
			expect(caps.supportsStreamJsonInput).toBe(true);
			expect(caps.supportsAppendSystemPrompt).toBe(true);
			expect(caps.supportsAdditionalDirectories).toBe(true);
			expect(caps.usesJsonLineOutput).toBe(false);
		});

		it('withholds standard permission mode, which is relay-gated to claude-code', () => {
			// handle-spawn.ts injects --permission-prompt-tool + --mcp-config only for
			// claude-code. Advertising the capability here would offer a mode that
			// spawns without the relay and aborts on the first tool call.
			expect(AGENT_CAPABILITIES.openclaude.supportsStandardPermissionMode).toBe(false);
		});

		it('withholds project memory, which reads ~/.claude', () => {
			expect(AGENT_CAPABILITIES.openclaude.supportsProjectMemory).toBe(false);
		});
	});

	describe('parser', () => {
		it('is registered and reports itself as openclaude', () => {
			const parser = createOutputParser('openclaude');
			expect(parser).not.toBeNull();
			expect(parser?.agentId).toBe('openclaude');
		});

		it('parses Claude-shaped stream-json identically to Claude Code', () => {
			const line = {
				type: 'assistant',
				session_id: 'sess-1',
				message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
			};
			const openclaudeEvent = createOutputParser('openclaude')?.parseJsonObject(line);
			const claudeEvent = createOutputParser('claude-code')?.parseJsonObject(line);

			expect(openclaudeEvent).toEqual(claudeEvent);
			expect(openclaudeEvent?.text).toBe('hello');
		});

		it('reads the session ID out of the snake_case field', () => {
			const parser = createOutputParser('openclaude');
			const event = parser?.parseJsonObject({
				type: 'system',
				subtype: 'init',
				session_id: 'sess-1',
			});
			expect(event && parser?.extractSessionId(event)).toBe('sess-1');
		});
	});

	describe('error patterns', () => {
		it('shares Claude Code’s set rather than falling through to empty', () => {
			const patterns = getErrorPatterns('openclaude');
			expect(patterns).toBe(getErrorPatterns('claude-code'));
			expect(Object.keys(patterns).length).toBeGreaterThan(0);
		});

		it('names OpenClaude, not Claude Code, when the binary is missing over SSH', () => {
			// The claude pattern is `.*claude.*`, which also matches "openclaude",
			// and the first match wins - so this only passes while the OpenClaude
			// entry stays ahead of it.
			expect(Object.keys(getSshErrorPatterns()).length).toBeGreaterThan(0);
			const match = matchSshErrorPattern('bash: openclaude: command not found');
			expect(match?.message).toContain('OpenClaude');
			expect(match?.message).not.toContain('Claude Code');
		});
	});

	describe('session storage', () => {
		const storage = new OpenClaudeSessionStorage();

		it('is a Claude storage that identifies as openclaude', () => {
			expect(storage).toBeInstanceOf(ClaudeSessionStorage);
			expect(storage.agentId).toBe('openclaude');
		});

		it('reads from the openclaude home, never Claude’s', () => {
			// getProjectsDir/getRemoteProjectsDir are private: reach through the
			// instance the same way the inherited methods do.
			const asAny = storage as unknown as {
				getProjectsDir(configDir?: string): string;
				getRemoteProjectsDir(): string;
			};
			expect(asAny.getProjectsDir()).toContain('.openclaude');
			expect(asAny.getRemoteProjectsDir()).toBe('~/.openclaude/projects');
		});

		it('does not disturb the Claude Code storage paths', () => {
			const claude = new ClaudeSessionStorage() as unknown as {
				getProjectsDir(configDir?: string): string;
				getRemoteProjectsDir(): string;
			};
			expect(claude.getProjectsDir()).toContain('.claude');
			expect(claude.getProjectsDir()).not.toContain('.openclaude');
			expect(claude.getRemoteProjectsDir()).toBe('~/.claude/projects');
		});
	});
});
