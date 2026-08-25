/**
 * Kilo (KiloCode) integration tests.
 *
 * Kilo is a fork of OpenCode, and the whole integration is built on that: the
 * parser and the session storage are subclasses, and the error patterns are
 * shared outright. These tests pin the parity that makes that safe, so a future
 * change to OpenCode that should have carried over to Kilo fails here instead
 * of silently leaving the fork behind.
 */

import { describe, it, expect } from 'vitest';
import { AGENT_DEFINITIONS, AGENT_CAPABILITIES } from '../../../main/agents';
import { AGENT_IDS } from '../../../shared/agentIds';
import {
	AGENT_DISPLAY_NAMES,
	AGENT_PICKER_META,
	PICKABLE_AGENT_IDS,
	isBetaAgent,
	getReadOnlyModeLabel,
} from '../../../shared/agentMetadata';
import { DEFAULT_CONTEXT_WINDOWS } from '../../../shared/agentConstants';
import { createOutputParser } from '../../../main/parsers/parser-factory';
import { getErrorPatterns } from '../../../main/parsers/error-patterns';
import { KiloSessionStorage } from '../../../main/storage/kilo-session-storage';
import { OpenCodeSessionStorage } from '../../../main/storage/opencode-session-storage';

const kiloDef = AGENT_DEFINITIONS.find((def) => def.id === 'kilo');
const opencodeDef = AGENT_DEFINITIONS.find((def) => def.id === 'opencode');

describe('Kilo agent', () => {
	describe('registration', () => {
		it('is a known agent id', () => {
			expect(AGENT_IDS).toContain('kilo');
		});

		it('has a definition and a display name', () => {
			expect(kiloDef).toBeDefined();
			expect(AGENT_DISPLAY_NAMES.kilo).toBe('Kilo');
		});

		it('is offered in the provider pickers and flagged beta', () => {
			expect(AGENT_PICKER_META.kilo).not.toBeNull();
			expect(PICKABLE_AGENT_IDS).toContain('kilo');
			expect(isBetaAgent('kilo')).toBe(true);
		});

		it('uses plan-mode wording, like OpenCode', () => {
			expect(getReadOnlyModeLabel('kilo')).toBe(getReadOnlyModeLabel('opencode'));
			expect(getReadOnlyModeLabel('kilo')).toBe('Plan-Mode');
		});

		it('has a default context window', () => {
			expect(DEFAULT_CONTEXT_WINDOWS.kilo).toBe(DEFAULT_CONTEXT_WINDOWS.opencode);
		});
	});

	describe('definition', () => {
		it('drives the kilo binary', () => {
			expect(kiloDef?.command).toBe('kilo');
			expect(kiloDef?.binaryName).toBe('kilo');
		});

		it('shares OpenCode CLI surface', () => {
			expect(kiloDef?.batchModePrefix).toEqual(opencodeDef?.batchModePrefix);
			expect(kiloDef?.jsonOutputArgs).toEqual(opencodeDef?.jsonOutputArgs);
			expect(kiloDef?.readOnlyArgs).toEqual(opencodeDef?.readOnlyArgs);
			expect(kiloDef?.readOnlyCliEnforced).toBe(opencodeDef?.readOnlyCliEnforced);
			expect(kiloDef?.resumeArgs?.('ses_abc')).toEqual(opencodeDef?.resumeArgs?.('ses_abc'));
			expect(kiloDef?.modelArgs?.('anthropic/claude')).toEqual(
				opencodeDef?.modelArgs?.('anthropic/claude')
			);
			expect(kiloDef?.imageArgs?.('/tmp/a.png')).toEqual(opencodeDef?.imageArgs?.('/tmp/a.png'));
		});

		it('configures permissions through its own env var, not OpenCode’s', () => {
			// A stray OPENCODE_CONFIG_CONTENT would be ignored by the kilo binary,
			// which re-enables the question tool and hangs batch mode on stdin.
			expect(kiloDef?.defaultEnvVars).toHaveProperty('KILO_CONFIG_CONTENT');
			expect(kiloDef?.defaultEnvVars).not.toHaveProperty('OPENCODE_CONFIG_CONTENT');
			expect(kiloDef?.readOnlyEnvOverrides).toHaveProperty('KILO_CONFIG_CONTENT');
			expect(kiloDef?.readOnlyEnvOverrides).not.toHaveProperty('OPENCODE_CONFIG_CONTENT');
		});

		it('disables the stdin-blocking question tool in both env payloads', () => {
			for (const payload of [
				kiloDef?.defaultEnvVars?.KILO_CONFIG_CONTENT,
				kiloDef?.readOnlyEnvOverrides?.KILO_CONFIG_CONTENT,
			]) {
				expect(payload).toBeDefined();
				const parsed = JSON.parse(payload as string);
				expect(parsed.permission.question).toBe('deny');
				expect(parsed.tools.question).toBe(false);
			}
		});
	});

	describe('capabilities', () => {
		it('mirrors OpenCode exactly', () => {
			expect(AGENT_CAPABILITIES.kilo).toEqual(AGENT_CAPABILITIES.opencode);
		});
	});

	describe('parser', () => {
		it('is registered and reports itself as kilo', () => {
			const parser = createOutputParser('kilo');
			expect(parser).not.toBeNull();
			expect(parser?.agentId).toBe('kilo');
		});

		it('parses OpenCode-shaped JSONL identically to OpenCode', () => {
			const line = {
				type: 'text',
				timestamp: 1,
				sessionID: 'ses_abc',
				part: { type: 'text', text: 'hello' },
			};
			const kiloEvent = createOutputParser('kilo')?.parseJsonObject(line);
			const opencodeEvent = createOutputParser('opencode')?.parseJsonObject(line);

			expect(kiloEvent).toEqual(opencodeEvent);
			expect(kiloEvent?.text).toBe('hello');
		});

		it('reads the session ID out of the camelCase field', () => {
			const parser = createOutputParser('kilo');
			const event = parser?.parseJsonObject({
				type: 'step_start',
				timestamp: 1,
				sessionID: 'ses_abc',
				part: { type: 'step-start' },
			});
			expect(event && parser?.extractSessionId(event)).toBe('ses_abc');
		});
	});

	describe('error patterns', () => {
		it('shares OpenCode’s set rather than falling through to empty', () => {
			const kiloPatterns = getErrorPatterns('kilo');
			expect(kiloPatterns).toBe(getErrorPatterns('opencode'));
			expect(Object.keys(kiloPatterns).length).toBeGreaterThan(0);
		});
	});

	describe('session storage', () => {
		const storage = new KiloSessionStorage();

		it('is an OpenCode storage that identifies as kilo', () => {
			expect(storage).toBeInstanceOf(OpenCodeSessionStorage);
			expect(storage.agentId).toBe('kilo');
		});

		it('reads from the kilo data directory, never OpenCode’s', () => {
			// getStorageDir/getDbPath are protected: reach through the instance the
			// same way the inherited methods do.
			const asAny = storage as unknown as {
				getStorageDir(): string;
				getDbPath(): string;
				getRemoteStorageDir(): string;
			};
			expect(asAny.getStorageDir()).toContain('kilo');
			expect(asAny.getStorageDir()).not.toContain('opencode');
			expect(asAny.getDbPath()).toContain('kilo.db');
			expect(asAny.getRemoteStorageDir()).toBe('~/.local/share/kilo/storage');
		});

		it('does not disturb the OpenCode storage paths', () => {
			const opencode = new OpenCodeSessionStorage() as unknown as {
				getStorageDir(): string;
				getDbPath(): string;
				getRemoteStorageDir(): string;
			};
			expect(opencode.getStorageDir()).toContain('opencode');
			expect(opencode.getDbPath()).toContain('opencode.db');
			expect(opencode.getRemoteStorageDir()).toBe('~/.local/share/opencode/storage');
		});
	});
});
