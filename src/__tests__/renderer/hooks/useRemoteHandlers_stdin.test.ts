/**
 * Integration tests for useRemoteHandlers.ts - Windows stdin transport flags
 *
 * These tests verify that remote command spawns correctly pass stdin transport
 * flags to window.maestro.process.spawn on Windows, avoiding command line
 * length limits (~8KB cmd.exe).
 *
 * Remote commands can include substituted slash command prompts (custom AI
 * commands, spec-kit, openspec) that may be very large after template
 * variable substitution.
 *
 * Unlike unit tests that call getStdinFlags in isolation, these tests exercise
 * the real hook event handler and assert on the actual spawn call arguments.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { Session, CustomAICommand } from '../../../renderer/types';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';

// ============================================================================
// Mock modules BEFORE importing the hook
// ============================================================================

vi.mock('../../../renderer/utils/ids', () => ({
	generateId: vi.fn(() => 'mock-id-' + Math.random().toString(36).slice(2, 8)),
}));

vi.mock('../../../renderer/utils/templateVariables', () => ({
	substituteTemplateVariables: vi.fn((prompt: string) => prompt),
}));

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getStatus: vi.fn().mockResolvedValue({ branch: 'main' }),
		getDiff: vi.fn().mockResolvedValue({ diff: '' }),
	},
}));

vi.mock('../../../renderer/utils/tabHelpers', () => ({
	getActiveTab: vi.fn((session: Session) => {
		if (!session?.aiTabs?.length) return null;
		return session.aiTabs.find((t: any) => t.id === session.activeTabId) || session.aiTabs[0];
	}),
}));

// Mock hasCapabilityCached - agents with batch mode support
const BATCH_MODE_AGENTS = new Set(['claude-code', 'codex', 'opencode', 'factory-droid']);
vi.mock('../../../renderer/hooks/agent/useAgentCapabilities', () => ({
	hasCapabilityCached: vi.fn((agentId: string, capability: string) => {
		if (capability === 'supportsBatchMode') return BATCH_MODE_AGENTS.has(agentId);
		return false;
	}),
}));

vi.mock('../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

vi.mock('../../../renderer/hooks/input/useInputProcessing', () => ({
	DEFAULT_IMAGE_ONLY_PROMPT: 'Describe this image.',
}));

// ============================================================================
// Now import the hook and stores
// ============================================================================

import {
	useRemoteHandlers,
	type UseRemoteHandlersDeps,
} from '../../../renderer/hooks/remote/useRemoteHandlers';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useUIStore } from '../../../renderer/stores/uiStore';

// ============================================================================
// Helpers
// ============================================================================

// Thin wrapper: populates an AI tab and terminal draft so remote command
// dispatching code has state to operate on.
function createMockSession(overrides: Partial<Session> = {}): Session {
	return baseCreateMockSession({
		name: 'Test Agent',
		cwd: '/test',
		fullPath: '/test',
		projectRoot: '/test',
		aiTabs: [
			{
				id: 'tab-1',
				name: 'Tab 1',
				inputValue: '',
				data: [],
				logs: [],
				stagedImages: [],
			},
		] as any,
		activeTabId: 'tab-1',
		shellCwd: '/test',
		terminalDraftInput: '',
		...overrides,
	});
}

function createMockDeps(overrides: Partial<UseRemoteHandlersDeps> = {}): UseRemoteHandlersDeps {
	return {
		sessionsRef: { current: [createMockSession()] },
		customAICommandsRef: { current: [] },
		speckitCommandsRef: { current: [] },
		openspecCommandsRef: { current: [] },
		toggleGlobalLive: vi.fn().mockResolvedValue(undefined),
		isLiveMode: false,
		sshRemoteConfigs: [],
		...overrides,
	};
}

/** Extract the maestro:remoteCommand event handler from addEventListener mock */
function getRemoteCommandHandler() {
	const call = (window.addEventListener as any).mock.calls.find(
		(c: any[]) => c[0] === 'maestro:remoteCommand'
	);
	if (!call) throw new Error('maestro:remoteCommand handler not registered');
	return call[1] as (event: Event) => Promise<void>;
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();

	// Reset stores
	const session = createMockSession();
	useSessionStore.setState({
		sessions: [session],
		activeSessionId: 'session-1',
	} as any);

	useSettingsStore.setState({
		conductorProfile: 'default',
	} as any);

	useUIStore.setState({
		setSuccessFlashNotification: vi.fn(),
	} as any);

	// Mock window.maestro APIs with platform set to win32 for stdin tests
	(window as any).maestro = {
		platform: 'win32',
		process: {
			spawn: vi.fn().mockResolvedValue(undefined),
			runCommand: vi.fn().mockResolvedValue(undefined),
		},
		agents: {
			get: vi.fn().mockResolvedValue({
				id: 'claude-code',
				command: 'claude',
				path: '/usr/local/bin/claude',
				args: [],
				capabilities: { supportsStreamJsonInput: true },
			}),
		},
		prompts: {
			get: vi.fn().mockResolvedValue({
				success: true,
				content: 'Maestro System Context: {{AGENT_NAME}}',
			}),
		},
		history: {
			getFilePath: vi.fn().mockResolvedValue(null),
		},
	};

	// Spy on addEventListener/removeEventListener for event listener extraction
	vi.spyOn(window, 'addEventListener');
	vi.spyOn(window, 'removeEventListener');
});

afterEach(() => {
	cleanup();
	// Restore platform to default
	if ((window as any).maestro) {
		(window as any).maestro.platform = 'darwin';
	}
});

// ============================================================================
// Tests
// ============================================================================

describe('useRemoteHandlers - remote command stdin flags (integration)', () => {
	it('should pass sendPromptViaStdinRaw=true in spawn call on Windows without SSH', async () => {
		const session = createMockSession();
		const deps = createMockDeps({
			sessionsRef: { current: [session] },
		});

		renderHook(() => useRemoteHandlers(deps));
		const handler = getRemoteCommandHandler();

		await act(async () => {
			await handler(
				new CustomEvent('maestro:remoteCommand', {
					detail: {
						sessionId: 'session-1',
						command: 'explain this code',
						inputMode: 'ai',
					},
				})
			);
		});

		expect((window as any).maestro.process.spawn).toHaveBeenCalled();
		const spawnCall = (window as any).maestro.process.spawn.mock.calls[0][0];

		// On Windows without SSH, text-only prompts use raw stdin
		expect(spawnCall.sendPromptViaStdinRaw).toBe(true);
		expect(spawnCall.sendPromptViaStdin).toBe(false);
	});

	it('should pass both stdin flags as false for SSH sessions on Windows', async () => {
		const session = createMockSession({
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
			},
		});

		useSessionStore.setState({
			sessions: [session],
			activeSessionId: 'session-1',
		} as any);

		const deps = createMockDeps({
			sessionsRef: { current: [session] },
		});

		renderHook(() => useRemoteHandlers(deps));
		const handler = getRemoteCommandHandler();

		await act(async () => {
			await handler(
				new CustomEvent('maestro:remoteCommand', {
					detail: {
						sessionId: 'session-1',
						command: 'explain this code',
						inputMode: 'ai',
					},
				})
			);
		});

		expect((window as any).maestro.process.spawn).toHaveBeenCalled();
		const spawnCall = (window as any).maestro.process.spawn.mock.calls[0][0];

		// SSH sessions must NOT use stdin flags
		expect(spawnCall.sendPromptViaStdin).toBe(false);
		expect(spawnCall.sendPromptViaStdinRaw).toBe(false);
	});

	it('should pass both stdin flags as false on non-Windows platforms', async () => {
		(window as any).maestro.platform = 'darwin';

		const session = createMockSession();
		const deps = createMockDeps({
			sessionsRef: { current: [session] },
		});

		renderHook(() => useRemoteHandlers(deps));
		const handler = getRemoteCommandHandler();

		await act(async () => {
			await handler(
				new CustomEvent('maestro:remoteCommand', {
					detail: {
						sessionId: 'session-1',
						command: 'explain this code',
						inputMode: 'ai',
					},
				})
			);
		});

		expect((window as any).maestro.process.spawn).toHaveBeenCalled();
		const spawnCall = (window as any).maestro.process.spawn.mock.calls[0][0];

		expect(spawnCall.sendPromptViaStdin).toBe(false);
		expect(spawnCall.sendPromptViaStdinRaw).toBe(false);
	});

	it('should pass sendPromptViaStdinRaw for agents without stream-json support', async () => {
		(window as any).maestro.agents.get.mockResolvedValue({
			id: 'opencode',
			command: 'opencode',
			path: '/usr/bin/opencode',
			args: [],
			capabilities: { supportsStreamJsonInput: false },
		});

		const session = createMockSession({
			toolType: 'opencode' as any,
		});

		useSessionStore.setState({
			sessions: [session],
			activeSessionId: 'session-1',
		} as any);

		const deps = createMockDeps({
			sessionsRef: { current: [session] },
		});

		renderHook(() => useRemoteHandlers(deps));
		const handler = getRemoteCommandHandler();

		await act(async () => {
			await handler(
				new CustomEvent('maestro:remoteCommand', {
					detail: {
						sessionId: 'session-1',
						command: 'explain this code',
						inputMode: 'ai',
					},
				})
			);
		});

		expect((window as any).maestro.process.spawn).toHaveBeenCalled();
		const spawnCall = (window as any).maestro.process.spawn.mock.calls[0][0];

		// Agents without stream-json always use raw stdin on Windows
		expect(spawnCall.sendPromptViaStdinRaw).toBe(true);
		expect(spawnCall.sendPromptViaStdin).toBe(false);
	});

	it('should handle disabled SSH config as non-SSH session', async () => {
		const session = createMockSession({
			sessionSshRemoteConfig: {
				enabled: false,
				remoteId: null as any,
			},
		});

		useSessionStore.setState({
			sessions: [session],
			activeSessionId: 'session-1',
		} as any);

		const deps = createMockDeps({
			sessionsRef: { current: [session] },
		});

		renderHook(() => useRemoteHandlers(deps));
		const handler = getRemoteCommandHandler();

		await act(async () => {
			await handler(
				new CustomEvent('maestro:remoteCommand', {
					detail: {
						sessionId: 'session-1',
						command: 'explain this code',
						inputMode: 'ai',
					},
				})
			);
		});

		expect((window as any).maestro.process.spawn).toHaveBeenCalled();
		const spawnCall = (window as any).maestro.process.spawn.mock.calls[0][0];

		// Disabled SSH should behave like a local session on Windows
		expect(spawnCall.sendPromptViaStdinRaw).toBe(true);
		expect(spawnCall.sendPromptViaStdin).toBe(false);
	});

	it('passes hasImages=false when the remote command carries no images', async () => {
		// Remote commands without an `images` array (the typical desktop+CLI
		// path, and any web client that didn't paste an image) must keep
		// sendPromptViaStdin=false so the stream-json branch isn't taken.
		// Web/mobile paste-image flow exercises the with-images branch
		// elsewhere.
		(window as any).maestro.agents.get.mockResolvedValue({
			id: 'claude-code',
			command: 'claude',
			path: '/usr/bin/claude',
			args: [],
			capabilities: { supportsStreamJsonInput: true },
		});

		const session = createMockSession();
		const deps = createMockDeps({
			sessionsRef: { current: [session] },
		});

		renderHook(() => useRemoteHandlers(deps));
		const handler = getRemoteCommandHandler();

		await act(async () => {
			await handler(
				new CustomEvent('maestro:remoteCommand', {
					detail: {
						sessionId: 'session-1',
						command: 'explain this code',
						inputMode: 'ai',
					},
				})
			);
		});

		expect((window as any).maestro.process.spawn).toHaveBeenCalled();
		const spawnCall = (window as any).maestro.process.spawn.mock.calls[0][0];

		// sendPromptViaStdin requires hasImages=true; this command has no images.
		expect(spawnCall.sendPromptViaStdin).toBe(false);
		// Raw stdin should be used instead on Windows
		expect(spawnCall.sendPromptViaStdinRaw).toBe(true);
		// And no images should be threaded into the spawn payload.
		expect(spawnCall.images).toBeUndefined();
	});

	it('threads pasted images into the spawn payload when the web client sends them', async () => {
		// Web/mobile clients can paste images into the chat composer; the
		// remote-command path forwards those base64 data URLs end-to-end so
		// the agent can attach them to the prompt, mirroring the desktop
		// stagedImages flow.
		(window as any).maestro.agents.get.mockResolvedValue({
			id: 'claude-code',
			command: 'claude',
			path: '/usr/bin/claude',
			args: [],
			capabilities: { supportsStreamJsonInput: true },
		});

		const session = createMockSession();
		const deps = createMockDeps({
			sessionsRef: { current: [session] },
		});

		renderHook(() => useRemoteHandlers(deps));
		const handler = getRemoteCommandHandler();

		const images = ['data:image/png;base64,abc'];
		await act(async () => {
			await handler(
				new CustomEvent('maestro:remoteCommand', {
					detail: {
						sessionId: 'session-1',
						command: 'what do you see?',
						inputMode: 'ai',
						images,
					},
				})
			);
		});

		expect((window as any).maestro.process.spawn).toHaveBeenCalled();
		const spawnCall = (window as any).maestro.process.spawn.mock.calls[0][0];
		expect(spawnCall.images).toEqual(images);
		// hasImages=true switches the stream-json branch on (when supported).
		expect(spawnCall.sendPromptViaStdin).toBe(true);
	});

	it('injects the image-only default prompt when the web client sends images with no text', async () => {
		// Image-only sends (paste an image, hit send without typing) reach the
		// renderer with command=''. Forwarding that empty string straight to the
		// agent CLI crashes Claude Code (`--print ''` exits code 1). The remote
		// handler must inject the user-customizable image-only default prompt,
		// mirroring the desktop input path. Regression test for IMG-03 in
		// PR #942.
		(window as any).maestro.agents.get.mockResolvedValue({
			id: 'claude-code',
			command: 'claude',
			path: '/usr/bin/claude',
			args: [],
			capabilities: { supportsStreamJsonInput: true },
		});

		const session = createMockSession();
		const deps = createMockDeps({
			sessionsRef: { current: [session] },
		});

		renderHook(() => useRemoteHandlers(deps));
		const handler = getRemoteCommandHandler();

		const images = ['data:image/png;base64,abc'];
		await act(async () => {
			await handler(
				new CustomEvent('maestro:remoteCommand', {
					detail: {
						sessionId: 'session-1',
						command: '',
						inputMode: 'ai',
						images,
					},
				})
			);
		});

		expect((window as any).maestro.process.spawn).toHaveBeenCalled();
		const spawnCall = (window as any).maestro.process.spawn.mock.calls[0][0];
		// Empty command + images must be replaced with the default prompt.
		expect(spawnCall.prompt).toBe('Describe this image.');
		expect(spawnCall.images).toEqual(images);
	});

	it('preserves a user-supplied prompt when images are also present', async () => {
		// Sanity check: the image-only fallback must not clobber a real prompt.
		(window as any).maestro.agents.get.mockResolvedValue({
			id: 'claude-code',
			command: 'claude',
			path: '/usr/bin/claude',
			args: [],
			capabilities: { supportsStreamJsonInput: true },
		});

		const session = createMockSession();
		const deps = createMockDeps({
			sessionsRef: { current: [session] },
		});

		renderHook(() => useRemoteHandlers(deps));
		const handler = getRemoteCommandHandler();

		await act(async () => {
			await handler(
				new CustomEvent('maestro:remoteCommand', {
					detail: {
						sessionId: 'session-1',
						command: 'what do you see?',
						inputMode: 'ai',
						images: ['data:image/png;base64,abc'],
					},
				})
			);
		});

		const spawnCall = (window as any).maestro.process.spawn.mock.calls[0][0];
		expect(spawnCall.prompt).toBe('what do you see?');
	});
});
