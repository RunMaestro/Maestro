/**
 * Tests for accountSwitchRespawn.ts - account switch respawn spawn config.
 *
 * The respawn after an account switch (throttle / auth recovery) must be
 * byte-for-byte equivalent to a normal user-initiated turn. These tests pin
 * the fields that historically drifted from the canonical dispatch:
 * - Windows stdin transport flags (cmd.exe ~8KB command line cap; the respawn
 *   replays exactly the long interrupted prompts that hit it)
 * - appendSystemPrompt (a resume without it silently drops the Maestro
 *   system prompt)
 * - images (an image-bearing turn must not resume as text-only)
 * - per-tab model/effort overrides
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import { buildAccountSwitchRespawnConfig } from '../../../renderer/utils/accountSwitchRespawn';

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getStatus: vi.fn().mockResolvedValue({ branch: 'main' }),
	},
}));

const mockAgent = {
	id: 'claude-code',
	name: 'Claude Code',
	available: true,
	command: 'claude',
	path: '/usr/bin/claude',
	args: ['--print'],
	capabilities: { supportsStreamJsonInput: true },
};

function makeSession(overrides: Record<string, unknown> = {}) {
	return createMockSession({
		id: 'session-1',
		toolType: 'claude-code',
		cwd: '/test/project',
		isGitRepo: false,
		customPath: '/custom/claude',
		customArgs: '--verbose',
		customEnvVars: { EXISTING_VAR: 'kept' },
		customModel: 'session-model',
		customEffort: 'medium',
		customContextWindow: 200000,
		aiTabs: [
			createMockAITab({
				id: 'tab-1',
				agentSessionId: 'agent-session-abc',
				permissionMode: 'standard',
				customModel: 'tab-model',
				customEffort: 'high',
			}),
		],
		activeTabId: 'tab-1',
		...overrides,
	} as any);
}

const respawnData = {
	toAccountId: 'account-2',
	configDir: '/accounts/account-2',
	lastPrompt: 'Resume this interrupted prompt',
	lastImages: null,
};

describe('buildAccountSwitchRespawnConfig', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(window as any).maestro = {
			platform: 'win32',
			agents: { get: vi.fn().mockResolvedValue(mockAgent) },
			prompts: {
				get: vi.fn().mockResolvedValue({ success: true, content: 'MAESTRO SYSTEM PROMPT' }),
			},
			history: { getFilePath: vi.fn().mockResolvedValue(null) },
		};
	});

	afterEach(() => {
		(window as any).maestro = { platform: 'darwin' };
	});

	it('includes Windows stdin flags for a text-only respawn (raw stdin)', async () => {
		const config = await buildAccountSwitchRespawnConfig(makeSession(), respawnData);

		expect(config).not.toBeNull();
		// Text-only prompt on Windows without SSH -> raw stdin transport, so a
		// long/multiline interrupted prompt cannot truncate on the cmd.exe argv.
		expect(config!.sendPromptViaStdinRaw).toBe(true);
		expect(config!.sendPromptViaStdin).toBe(false);
	});

	it('includes the Maestro system prompt on the resumed turn', async () => {
		const config = await buildAccountSwitchRespawnConfig(makeSession(), respawnData);

		expect((window as any).maestro.prompts.get).toHaveBeenCalledWith('maestro-system-prompt');
		expect(config!.appendSystemPrompt).toBe('MAESTRO SYSTEM PROMPT');
	});

	it('threads images through and switches to stream-json stdin', async () => {
		const images = ['data:image/png;base64,AAAA'];
		const config = await buildAccountSwitchRespawnConfig(makeSession(), {
			...respawnData,
			lastImages: images,
		});

		expect(config!.images).toEqual(images);
		// Images + stream-json support on Windows -> JSON stdin transport
		expect(config!.sendPromptViaStdin).toBe(true);
		expect(config!.sendPromptViaStdinRaw).toBe(false);
	});

	it('applies per-tab effort and model overrides like the canonical dispatch', async () => {
		const config = await buildAccountSwitchRespawnConfig(makeSession(), respawnData);

		expect(config!.sessionCustomEffort).toBe('high');
		expect(config!.sessionCustomModel).toBe('tab-model');
	});

	it('falls back to session-level effort and model when the tab has none', async () => {
		const session = makeSession({
			aiTabs: [
				createMockAITab({
					id: 'tab-1',
					agentSessionId: 'agent-session-abc',
					permissionMode: 'standard',
				}),
			],
		});
		const config = await buildAccountSwitchRespawnConfig(session, respawnData);

		expect(config!.sessionCustomEffort).toBe('medium');
		expect(config!.sessionCustomModel).toBe('session-model');
	});

	it('preserves resume identity, account pinning, and the new config dir', async () => {
		const config = await buildAccountSwitchRespawnConfig(makeSession(), respawnData);

		expect(config!.sessionId).toBe('session-1-ai-tab-1');
		expect(config!.prompt).toBe('Resume this interrupted prompt');
		expect(config!.agentSessionId).toBe('agent-session-abc');
		expect(config!.accountId).toBe('account-2');
		expect(config!.sessionCustomEnvVars).toEqual({
			EXISTING_VAR: 'kept',
			CLAUDE_CONFIG_DIR: '/accounts/account-2',
		});
		expect(config!.permissionMode).toBe('standard');
		expect(config!.readOnlyMode).toBe(false);
		expect(config!.sessionCustomPath).toBe('/custom/claude');
		expect(config!.sessionCustomArgs).toBe('--verbose');
		expect(config!.sessionCustomContextWindow).toBe(200000);
	});

	it('suppresses stdin flags for SSH sessions', async () => {
		const session = makeSession({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});
		const config = await buildAccountSwitchRespawnConfig(session, respawnData);

		expect(config!.sendPromptViaStdin).toBe(false);
		expect(config!.sendPromptViaStdinRaw).toBe(false);
	});

	it('suppresses stdin flags for agent-level SSH remotes (sshRemoteId)', async () => {
		const session = makeSession({ sshRemoteId: 'remote-1' });
		const config = await buildAccountSwitchRespawnConfig(session, respawnData);

		expect(config!.sendPromptViaStdin).toBe(false);
		expect(config!.sendPromptViaStdinRaw).toBe(false);
	});

	it('returns null when the agent is unavailable', async () => {
		(window as any).maestro.agents.get.mockResolvedValue({ ...mockAgent, available: false });
		const config = await buildAccountSwitchRespawnConfig(makeSession(), respawnData);
		expect(config).toBeNull();
	});
});
