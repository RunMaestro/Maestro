/**
 * Phase 3b verification (pure half): the shape of the corrective turn TTSR
 * respawns after main aborted the offending one.
 */

import { describe, it, expect } from 'vitest';
import { createMockAITab, createMockSession } from '../../helpers';
import { buildTtsrRespawnConfig, resolveTtsrTarget } from '../../../renderer/utils/ttsrRespawn';
import type { TtsrTriggeredPayload } from '../../../shared/ttsr-types';

function makePayload(overrides: Partial<TtsrTriggeredPayload> = {}): TtsrTriggeredPayload {
	return {
		sessionId: 'session-1-ai-tab-1',
		tabId: 'tab-1',
		agentId: 'claude-code',
		rules: [{ name: 'no-console-log', path: '.maestro/rules/no-console-log.md' }],
		injectionPrompt: '<system-interrupt rule="no-console-log">Use the logger.</system-interrupt>',
		mode: 'resume',
		providerSessionId: 'prov-1',
		originalGoal: 'Refactor the auth module',
		contextMode: 'keep',
		...overrides,
	};
}

const AGENT = {
	command: 'claude',
	path: '/usr/local/bin/claude',
	args: ['--print', '--dangerously-skip-permissions'],
	capabilities: { supportsStreamJsonInput: true },
};

describe('resolveTtsrTarget', () => {
	it('finds the session and tab behind a process session id', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'session-1', aiTabs: [tab] });

		expect(resolveTtsrTarget([session], makePayload())).toEqual({ session, tab });
	});

	it('resolves a forced-parallel session id (the -fp- suffix)', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'session-1', aiTabs: [tab] });
		const payload = makePayload({ sessionId: 'session-1-ai-tab-1-fp-1717171717' });

		expect(resolveTtsrTarget([session], payload)?.tab).toBe(tab);
	});

	it('returns null when the tab is gone', () => {
		const session = createMockSession({ id: 'session-1', aiTabs: [] });
		expect(resolveTtsrTarget([session], makePayload())).toBeNull();
	});

	it('returns null for a non-AI process id', () => {
		const session = createMockSession({ id: 'session-1' });
		const payload = makePayload({ sessionId: 'session-1-terminal' });
		expect(resolveTtsrTarget([session], payload)).toBeNull();
	});
});

describe('buildTtsrRespawnConfig', () => {
	it('resumes with the provider id main captured, not the tab cache', () => {
		// The tab's cached id can lag or belong to an earlier turn; Gate B makes
		// the payload authoritative.
		const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'stale-id' });
		const session = createMockSession({ id: 'session-1', aiTabs: [tab] });

		const config = buildTtsrRespawnConfig({
			payload: makePayload(),
			session,
			tab,
			agent: AGENT,
			appendSystemPrompt: 'system prompt',
		});

		expect(config).toMatchObject({
			sessionId: 'session-1-ai-tab-1',
			toolType: 'claude-code',
			cwd: '/test/project',
			command: '/usr/local/bin/claude',
			agentSessionId: 'prov-1',
			appendSystemPrompt: 'system prompt',
			permissionMode: 'full',
			readOnlyMode: false,
		});
		expect(config.prompt).toContain('<system-interrupt');
	});

	it('sends no session id on the degraded fresh path so no resumeArgs are built', () => {
		const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'stale-id' });
		const session = createMockSession({ id: 'session-1', toolType: 'grok', aiTabs: [tab] });
		const payload = makePayload({
			agentId: 'grok',
			mode: 'fresh',
			providerSessionId: undefined,
			injectionPrompt: 'Continuing this request: Refactor the auth module\n\n<system-interrupt/>',
		});

		const config = buildTtsrRespawnConfig({ payload, session, tab, agent: AGENT });

		expect(config.agentSessionId).toBeUndefined();
		expect(config.prompt).toContain('Continuing this request: Refactor the auth module');
	});

	it('keeps a read-only tab read-only and strips permission-bypass flags', () => {
		const tab = createMockAITab({ id: 'tab-1', permissionMode: 'readonly' });
		const session = createMockSession({ id: 'session-1', aiTabs: [tab] });

		const config = buildTtsrRespawnConfig({ payload: makePayload(), session, tab, agent: AGENT });

		expect(config.readOnlyMode).toBe(true);
		expect(config.permissionMode).toBe('readonly');
		expect(config.args).toEqual(['--print']);
	});

	it('carries per-session and per-tab overrides through to the corrective turn', () => {
		const tab = createMockAITab({ id: 'tab-1', customModel: 'tab-model' });
		const session = createMockSession({
			id: 'session-1',
			aiTabs: [tab],
			customModel: 'session-model',
			customEffort: 'high',
			customPath: '/custom/claude',
			customEnvVars: { FOO: 'bar' },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});

		const config = buildTtsrRespawnConfig({ payload: makePayload(), session, tab, agent: AGENT });

		expect(config.sessionCustomModel).toBe('tab-model');
		expect(config.sessionCustomEffort).toBe('high');
		expect(config.sessionCustomPath).toBe('/custom/claude');
		expect(config.sessionCustomEnvVars).toEqual({ FOO: 'bar' });
		expect(config.sessionSshRemoteConfig).toEqual({ enabled: true, remoteId: 'remote-1' });
	});

	it('refuses to spawn an agent with no command', () => {
		const tab = createMockAITab({ id: 'tab-1' });
		const session = createMockSession({ id: 'session-1', aiTabs: [tab] });

		expect(() =>
			buildTtsrRespawnConfig({ payload: makePayload(), session, tab, agent: {} })
		).toThrow(/no command configured/);
	});
});
