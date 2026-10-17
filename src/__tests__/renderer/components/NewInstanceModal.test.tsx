/**
 * @fileoverview Tests for NewInstanceModal component
 * Tests: Modal rendering, agent detection, folder selection, form submission,
 * tilde expansion, layer stack integration, keyboard shortcuts, custom agent paths
 */

import type React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { logger } from '../../../renderer/utils/logger';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { NewInstanceModal } from '../../../renderer/components/NewInstanceModal';
import { formatShortcutKeys } from '../../../renderer/utils/shortcutFormatter';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useModalStore } from '../../../renderer/stores/modalStore';
import type { Theme, Session } from '../../../renderer/types';
import type { AgentConfig } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';

// lucide-react icons are mocked globally in src/__tests__/setup.ts using a Proxy

// Mock layer stack context
const mockRegisterLayer = vi.fn(() => 'layer-new-instance-123');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

// Create test theme
const createTheme = (): Theme => ({
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		textMain: '#e8e8e8',
		textDim: '#888888',
		accent: '#7b2cbf',
		accentDim: '#5a1f8f',
		accentForeground: '#ffffff',
		border: '#333355',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		info: '#3b82f6',
		bgAccentHover: '#9333ea',
	},
});

// Create test agent configs
/**
 * The 25th `onCreate` argument of a form whose Peers tab was never touched:
 * every source of the roster is absent, which is what the data model reads as off.
 */
const NO_PEER_GRANTS = {
	peerAgents: undefined,
	groupPeerAccess: undefined,
	worktreePeerAccess: undefined,
};

const createAgentConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
	id: 'claude-code',
	name: 'Claude Code',
	available: true,
	path: '/usr/local/bin/claude',
	binaryName: 'claude',
	hidden: false,
	...overrides,
});

/**
 * Reveal every provider row.
 *
 * The picker hides what this machine cannot run by default, so a test that
 * asserts on ordering, badges, or unavailable rows has to ask for them first -
 * otherwise it is asserting against the filtered view.
 */
const showAllProviders = async (): Promise<void> => {
	const toggle = await screen.findByRole('switch', { name: 'Show all supported providers' });
	fireEvent.click(toggle);
};

/**
 * Show one tab of the agent settings form. Only the active panel is rendered,
 * so a field on another tab is not in the document until its tab is opened.
 */
const openTab = (name: string) =>
	fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${name}`) }));

describe('NewInstanceModal', () => {
	let theme: Theme;
	let onClose: ReturnType<typeof vi.fn>;
	let onCreate: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		theme = createTheme();
		onClose = vi.fn();
		onCreate = vi.fn();

		// Reset all mocks
		mockRegisterLayer.mockClear().mockReturnValue('layer-new-instance-123');
		mockUnregisterLayer.mockClear();
		mockUpdateLayerHandler.mockClear();

		// Setup default mock implementations
		vi.mocked(window.maestro.fs.homeDir).mockResolvedValue('/home/testuser');
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([
			createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
		]);
		vi.mocked(window.maestro.agents.getAllCustomPaths).mockResolvedValue({});
		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue(null);
		vi.mocked(window.maestro.agents.refresh).mockResolvedValue({
			agents: [createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true })],
			debugInfo: null,
		});
		vi.mocked(window.maestro.agents.setCustomPath).mockResolvedValue(undefined);
		// Default: no SSH remotes configured
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [],
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
		// Reset groups so tests don't leak group state between cases
		useSessionStore.setState({ groups: [] });
	});

	describe('Initial render and visibility', () => {
		it('should render null when isOpen is false', async () => {
			const { container } = render(
				<NewInstanceModal
					isOpen={false}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			// Wait for any pending promises to resolve
			await act(async () => {
				await Promise.resolve();
			});
			expect(container.firstChild).toBeNull();
		});

		it('should render modal with dialog role when isOpen is true', async () => {
			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			const modal = screen.getByRole('dialog');
			expect(modal).toBeInTheDocument();
			expect(modal).toHaveAttribute('aria-modal', 'true');
			expect(modal).toHaveAttribute('aria-label', 'Create New Agent');
		});

		it('should display modal header with title and close button', async () => {
			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			expect(screen.getByText('Create New Agent')).toBeInTheDocument();
			expect(screen.getByTestId('x-icon')).toBeInTheDocument();
		});

		it('should show loading state initially', () => {
			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			expect(screen.getByText('Loading agents...')).toBeInTheDocument();
		});
	});

	describe('Agent detection and display', () => {
		it('should load and display available agents', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({
					id: 'claude-code',
					name: 'Claude Code',
					available: true,
					path: '/usr/bin/claude',
				}),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
				expect(screen.getByText('Available')).toBeInTheDocument();
			});
		});

		it('should list supported agents alphabetically, with coming-soon ones below', async () => {
			// Detection order is arbitrary, so the rows must not inherit it. Each
			// bucket sorts by the name the row renders, matching the wizard tile
			// strip and the Group Chat moderator dropdown.
			const expected = ['Antigravity CLI', 'Codex', 'Grok CLI', 'OpenCode', 'Gemini CLI'];
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'opencode', name: 'OpenCode', available: true }),
				createAgentConfig({ id: 'gemini-cli', name: 'Gemini CLI', available: false }),
				createAgentConfig({ id: 'grok', name: 'Grok CLI', available: true }),
				createAgentConfig({ id: 'codex', name: 'Codex', available: true }),
				createAgentConfig({ id: 'antigravity', name: 'Antigravity CLI', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			// Gemini CLI is unavailable, so the default filter hides it. This test is
			// about ORDER across both buckets, so ask for every row.
			await showAllProviders();

			await waitFor(() => {
				expect(screen.getByText('Antigravity CLI')).toBeInTheDocument();
			});

			const names = within(screen.getByRole('listbox', { name: 'Agent provider selection' }))
				.getAllByRole('option')
				.map((row) => row.textContent ?? '')
				.map((text) => expected.find((name) => text.includes(name)));

			// Gemini CLI is not pickable, so it sinks to the bottom even though
			// its name sorts ahead of Grok CLI and OpenCode.
			expect(names).toEqual(expected);
		});

		it('should display path for available agents', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({
					id: 'claude-code',
					name: 'Claude Code',
					available: true,
					path: '/usr/bin/claude',
				}),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			// Wait for agents to load, then click to expand
			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});
			fireEvent.click(screen.getByText('Claude Code'));

			// Path is now pre-filled in the input field, not displayed as separate text
			await waitFor(() => {
				expect(screen.getByDisplayValue('/usr/bin/claude')).toBeInTheDocument();
			});
		});

		it('should display "Not Found" for unavailable Claude Code agent', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: false, path: null }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			await waitFor(() => {
				expect(screen.getByText('Not Found')).toBeInTheDocument();
			});
		});

		it('should display "Coming Soon" for non-claude-code agents', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
				createAgentConfig({ id: 'openai-codex', name: 'OpenAI Codex', available: false }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			// A coming-soon provider cannot be run, so it is filtered out by default.
			await showAllProviders();

			await waitFor(() => {
				expect(screen.getByText('Coming Soon')).toBeInTheDocument();
			});
		});

		it('hides providers this machine cannot run until asked', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
				createAgentConfig({ id: 'codex', name: 'Codex', available: false }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});
			expect(screen.queryByText('Codex')).toBeNull();

			// The count describes ALL supported providers, not the filtered rows -
			// "1 of 1" would answer nothing.
			expect(screen.getByText('1 of 2 locally')).toBeInTheDocument();

			await showAllProviders();
			await waitFor(() => {
				expect(screen.getByText('Codex')).toBeInTheDocument();
			});
		});

		it('keeps the selected provider on screen even when it is missing', async () => {
			// Duplicating an agent whose provider is not installed here would
			// otherwise hide the row that shows what is selected.
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
				createAgentConfig({ id: 'codex', name: 'Codex', available: false }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
					sourceSession={
						{
							id: 'source-1',
							name: 'Old Agent',
							toolType: 'codex',
							cwd: '/test/project',
							projectRoot: '/test/project',
							fullPath: '/test/project',
							state: 'idle',
							inputMode: 'ai',
							aiTabs: [],
							closedTabHistory: [],
							shellLogs: [],
							executionQueue: [],
							contextUsage: 0,
							workLog: [],
							isGitRepo: false,
							changedFiles: [],
							fileTree: [],
							fileExplorerExpanded: [],
							fileExplorerScrollPos: 0,
							isLive: false,
						} as unknown as Session
					}
				/>
			);
			openTab('Provider');

			await waitFor(() => {
				expect(screen.getByText('Codex')).toBeInTheDocument();
			});
		});

		it('should hide hidden agents from display', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
				createAgentConfig({
					id: 'hidden-agent',
					name: 'Hidden Agent',
					available: true,
					hidden: true,
				}),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});

			expect(screen.queryByText('Hidden Agent')).not.toBeInTheDocument();
		});

		it('should select default agent when available', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			await waitFor(() => {
				const option = screen.getByRole('option', { name: /Claude Code/i });
				expect(option).toHaveAttribute('aria-selected', 'true');
			});
		});

		it('should select first available agent when default is not available', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'unavailable-agent', name: 'Unavailable Agent', available: false }),
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			await waitFor(() => {
				const options = screen.getAllByRole('option');
				const claudeOption = options.find((opt) => opt.textContent?.includes('Claude Code'));
				expect(claudeOption).toHaveAttribute('aria-selected', 'true');
			});
		});
	});

	describe('Agent selection', () => {
		it('should allow selecting claude-code when available', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});

			const option = screen.getByRole('option', { name: /Claude Code/i });
			fireEvent.click(option);
			expect(option).toHaveAttribute('aria-selected', 'true');
		});

		it('should allow selecting unavailable claude-code to configure custom path', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: false }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});

			const option = screen.getByRole('option', { name: /Claude Code/i });
			fireEvent.click(option);
			// Should be selected so user can configure a custom path
			expect(option).toHaveAttribute('aria-selected', 'true');
		});

		it('should not allow selecting non-claude-code agents', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
				createAgentConfig({ id: 'openai-codex', name: 'OpenAI Codex', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			// `openai-codex` is not a pickable id, so the default filter hides it.
			await showAllProviders();

			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});

			const codexOption = screen.getByRole('option', { name: /OpenAI Codex/i });
			fireEvent.click(codexOption);
			// Should still have claude-code selected
			const claudeOption = screen.getByRole('option', { name: /Claude Code/i });
			expect(claudeOption).toHaveAttribute('aria-selected', 'true');
		});
	});

	describe('Agent refresh', () => {
		it('should refresh agent when refresh button is clicked', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);
			vi.mocked(window.maestro.agents.refresh).mockResolvedValue({
				agents: [createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true })],
				debugInfo: null,
			});

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});

			const refreshButton = screen.getByTitle('Refresh detection');
			await act(async () => {
				fireEvent.click(refreshButton);
			});

			expect(window.maestro.agents.refresh).toHaveBeenCalledWith('claude-code');
		});

		it('should display debug info when agent refresh shows not found', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: false }),
			]);
			vi.mocked(window.maestro.agents.refresh).mockResolvedValue({
				agents: [createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: false })],
				debugInfo: {
					agentId: 'claude-code',
					available: false,
					path: null,
					binaryName: 'claude',
					envPath: '/usr/bin:/usr/local/bin',
					homeDir: '/home/testuser',
					platform: 'darwin',
					whichCommand: 'which',
					error: 'Command not found in PATH',
				},
			});

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});

			const refreshButton = screen.getByTitle('Refresh detection');
			await act(async () => {
				fireEvent.click(refreshButton);
			});

			await waitFor(() => {
				expect(screen.getByText('Debug Info: claude not found')).toBeInTheDocument();
				expect(screen.getByText('Command not found in PATH')).toBeInTheDocument();
				expect(screen.getByText('darwin')).toBeInTheDocument();
			});
		});

		it('should dismiss debug info when dismiss button is clicked', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: false }),
			]);
			vi.mocked(window.maestro.agents.refresh).mockResolvedValue({
				agents: [createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: false })],
				debugInfo: {
					agentId: 'claude-code',
					available: false,
					path: null,
					binaryName: 'claude',
					envPath: '/usr/bin',
					homeDir: '/home/testuser',
					platform: 'darwin',
					whichCommand: 'which',
					error: 'Not found',
				},
			});

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});

			const refreshButton = screen.getByTitle('Refresh detection');
			await act(async () => {
				fireEvent.click(refreshButton);
			});

			await waitFor(() => {
				expect(screen.getByText('Dismiss')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByText('Dismiss'));

			await waitFor(() => {
				expect(screen.queryByText(/Debug Info:/)).not.toBeInTheDocument();
			});
		});
	});

	describe('Form inputs', () => {
		it('should allow typing in instance name input', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				expect(screen.getByLabelText('Agent Name')).toBeInTheDocument();
			});

			const nameInput = screen.getByLabelText('Agent Name');
			fireEvent.change(nameInput, { target: { value: 'My Custom Session' } });
			expect(nameInput).toHaveValue('My Custom Session');
		});

		it('should allow typing in working directory input', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				expect(screen.getByPlaceholderText('Select directory...')).toBeInTheDocument();
			});

			const dirInput = screen.getByPlaceholderText('Select directory...');
			fireEvent.change(dirInput, { target: { value: '/path/to/project' } });
			expect(dirInput).toHaveValue('/path/to/project');
		});

		it('should focus name input on modal open', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				const nameInput = screen.getByLabelText('Agent Name');
				expect(document.activeElement).toBe(nameInput);
			});
		});
	});

	describe('Folder selection', () => {
		it('should open folder dialog when folder button is clicked', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);
			vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue('/selected/folder');

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				expect(
					screen.getByTitle(`Browse folders (${formatShortcutKeys(['Meta', 'o'])})`)
				).toBeInTheDocument();
			});

			const folderButton = screen.getByTitle(
				`Browse folders (${formatShortcutKeys(['Meta', 'o'])})`
			);
			await act(async () => {
				fireEvent.click(folderButton);
			});

			expect(window.maestro.dialog.selectFolder).toHaveBeenCalled();

			await waitFor(() => {
				expect(screen.getByPlaceholderText('Select directory...')).toHaveValue('/selected/folder');
			});
		});

		it('should not update input when folder selection is cancelled', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);
			vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue(null);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				expect(
					screen.getByTitle(`Browse folders (${formatShortcutKeys(['Meta', 'o'])})`)
				).toBeInTheDocument();
			});

			const dirInput = screen.getByPlaceholderText('Select directory...');
			fireEvent.change(dirInput, { target: { value: '/existing/path' } });

			const folderButton = screen.getByTitle(
				`Browse folders (${formatShortcutKeys(['Meta', 'o'])})`
			);
			await act(async () => {
				fireEvent.click(folderButton);
			});

			expect(dirInput).toHaveValue('/existing/path');
		});
	});

	describe('Tilde expansion', () => {
		it('should expand tilde to home directory on create', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);
			vi.mocked(window.maestro.fs.homeDir).mockResolvedValue('/home/testuser');

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				expect(screen.getByPlaceholderText('Select directory...')).toBeInTheDocument();
			});

			const nameInput = screen.getByLabelText('Agent Name');
			fireEvent.change(nameInput, { target: { value: 'My Session' } });

			const dirInput = screen.getByPlaceholderText('Select directory...');
			fireEvent.change(dirInput, { target: { value: '~/projects' } });

			const createButton = screen.getByText('Create Agent');
			await act(async () => {
				fireEvent.click(createButton);
			});

			expect(onCreate).toHaveBeenCalledWith(
				'claude-code',
				'/home/testuser/projects',
				'My Session',
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				expect.objectContaining({ enabled: false, remoteId: null }),
				undefined,
				undefined,
				undefined, // enableMaestroP unset: API is the default for Claude Code (Adaptive Mode off)
				undefined, // maestroPPath
				undefined, // maestroPMode unset until the user opts into TUI/Dynamic
				true, // retryOnAvailabilityErrors
				true, // retryOnTokenExhaustion
				undefined, // additionalDirectories
				false, // codexAutoResetOnExhaustion: off by default
				'exec', // codexTransport: Standard by default
				undefined, // gatewayUrl: none unless set on the Models tab
				undefined, // runOn: the provider's own model unless chosen on the Models tab
				NO_PEER_GRANTS, // peerGrants: nothing granted unless set on the Peers tab
				undefined // seedExtras: only a form seeded from a group's defaults has any
			);
		});

		it('should expand lone tilde to home directory', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);
			vi.mocked(window.maestro.fs.homeDir).mockResolvedValue('/home/testuser');

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				expect(screen.getByPlaceholderText('Select directory...')).toBeInTheDocument();
			});

			const nameInput = screen.getByLabelText('Agent Name');
			fireEvent.change(nameInput, { target: { value: 'Home Session' } });

			const dirInput = screen.getByPlaceholderText('Select directory...');
			fireEvent.change(dirInput, { target: { value: '~' } });

			const createButton = screen.getByText('Create Agent');
			await act(async () => {
				fireEvent.click(createButton);
			});

			expect(onCreate).toHaveBeenCalledWith(
				'claude-code',
				'/home/testuser',
				'Home Session',
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				expect.objectContaining({ enabled: false, remoteId: null }),
				undefined,
				undefined,
				undefined, // enableMaestroP unset: API is the default for Claude Code (Adaptive Mode off)
				undefined, // maestroPPath
				undefined, // maestroPMode unset until the user opts into TUI/Dynamic
				true, // retryOnAvailabilityErrors
				true, // retryOnTokenExhaustion
				undefined, // additionalDirectories
				false, // codexAutoResetOnExhaustion: off by default
				'exec', // codexTransport: Standard by default
				undefined, // gatewayUrl: none unless set on the Models tab
				undefined, // runOn: the provider's own model unless chosen on the Models tab
				NO_PEER_GRANTS, // peerGrants: nothing granted unless set on the Peers tab
				undefined // seedExtras: only a form seeded from a group's defaults has any
			);
		});

		it('should not expand tilde in middle of path', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);
			vi.mocked(window.maestro.fs.homeDir).mockResolvedValue('/home/testuser');

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				expect(screen.getByPlaceholderText('Select directory...')).toBeInTheDocument();
			});

			const nameInput = screen.getByLabelText('Agent Name');
			fireEvent.change(nameInput, { target: { value: 'Tilde Test' } });

			const dirInput = screen.getByPlaceholderText('Select directory...');
			fireEvent.change(dirInput, { target: { value: '/path/with~tilde' } });

			const createButton = screen.getByText('Create Agent');
			await act(async () => {
				fireEvent.click(createButton);
			});

			expect(onCreate).toHaveBeenCalledWith(
				'claude-code',
				'/path/with~tilde',
				'Tilde Test',
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				expect.objectContaining({ enabled: false, remoteId: null }),
				undefined,
				undefined,
				undefined, // enableMaestroP unset: API is the default for Claude Code (Adaptive Mode off)
				undefined, // maestroPPath
				undefined, // maestroPMode unset until the user opts into TUI/Dynamic
				true, // retryOnAvailabilityErrors
				true, // retryOnTokenExhaustion
				undefined, // additionalDirectories
				false, // codexAutoResetOnExhaustion: off by default
				'exec', // codexTransport: Standard by default
				undefined, // gatewayUrl: none unless set on the Models tab
				undefined, // runOn: the provider's own model unless chosen on the Models tab
				NO_PEER_GRANTS, // peerGrants: nothing granted unless set on the Peers tab
				undefined // seedExtras: only a form seeded from a group's defaults has any
			);
		});
	});

	describe('Form submission', () => {
		it('should call onCreate with correct values when Create button is clicked', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				expect(screen.getByLabelText('Agent Name')).toBeInTheDocument();
			});

			const nameInput = screen.getByLabelText('Agent Name');
			fireEvent.change(nameInput, { target: { value: 'My Session' } });

			const dirInput = screen.getByPlaceholderText('Select directory...');
			fireEvent.change(dirInput, { target: { value: '/my/project' } });

			const createButton = screen.getByText('Create Agent');
			await act(async () => {
				fireEvent.click(createButton);
			});

			expect(onCreate).toHaveBeenCalledWith(
				'claude-code',
				'/my/project',
				'My Session',
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				expect.objectContaining({ enabled: false, remoteId: null }),
				undefined,
				undefined,
				undefined, // enableMaestroP unset: API is the default for Claude Code (Adaptive Mode off)
				undefined, // maestroPPath
				undefined, // maestroPMode unset until the user opts into TUI/Dynamic
				true, // retryOnAvailabilityErrors
				true, // retryOnTokenExhaustion
				undefined, // additionalDirectories
				false, // codexAutoResetOnExhaustion: off by default
				'exec', // codexTransport: Standard by default
				undefined, // gatewayUrl: none unless set on the Models tab
				undefined, // runOn: the provider's own model unless chosen on the Models tab
				NO_PEER_GRANTS, // peerGrants: nothing granted unless set on the Peers tab
				undefined // seedExtras: only a form seeded from a group's defaults has any
			);
			expect(onClose).toHaveBeenCalled();
		});

		it('should disable Create button when no instance name provided', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				expect(screen.getByPlaceholderText('Select directory...')).toBeInTheDocument();
			});

			const dirInput = screen.getByPlaceholderText('Select directory...');
			fireEvent.change(dirInput, { target: { value: '/my/project' } });

			// Button should be disabled because instance name is not provided
			const createButton = screen.getByText('Create Agent');
			expect(createButton).toBeDisabled();
		});

		it('should disable Create button when no working directory', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});

			const createButton = screen.getByText('Create Agent');
			expect(createButton).toBeDisabled();
		});

		it('should disable Create button when agent is not available', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: false }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});

			openTab('General');
			const dirInput = screen.getByPlaceholderText('Select directory...');
			fireEvent.change(dirInput, { target: { value: '/my/project' } });

			const createButton = screen.getByText('Create Agent');
			expect(createButton).toBeDisabled();
		});

		it('should reset form after creation', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			const { rerender } = render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				expect(screen.getByLabelText('Agent Name')).toBeInTheDocument();
			});

			const nameInput = screen.getByLabelText('Agent Name');
			fireEvent.change(nameInput, { target: { value: 'Test Session' } });

			const dirInput = screen.getByPlaceholderText('Select directory...');
			fireEvent.change(dirInput, { target: { value: '/test/path' } });

			const createButton = screen.getByText('Create Agent');
			await act(async () => {
				fireEvent.click(createButton);
			});

			// Re-render with isOpen=true to check reset (simulating modal reopen)
			rerender(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				expect(screen.getByLabelText('Agent Name')).toHaveValue('');
				expect(screen.getByPlaceholderText('Select directory...')).toHaveValue('');
			});
		});
	});

	describe('Cancel button', () => {
		it('should call onClose when Cancel button is clicked', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('Cancel')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
			expect(onClose).toHaveBeenCalled();
		});

		it('should call onClose when X button is clicked', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				expect(screen.getByTestId('x-icon')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTestId('x-icon').parentElement!);
			expect(onClose).toHaveBeenCalled();
		});
	});

	describe('Keyboard shortcuts', () => {
		it('should trigger folder selection on Cmd+O', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);
			vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue('/selected/via/shortcut');

			const { container } = render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				expect(screen.getByRole('dialog')).toBeInTheDocument();
			});

			// Keyboard events are handled by the wrapper div around Modal
			const wrapper = container.firstChild as HTMLElement;
			await act(async () => {
				fireEvent.keyDown(wrapper, { key: 'o', metaKey: true });
			});

			expect(window.maestro.dialog.selectFolder).toHaveBeenCalled();
		});

		it('should trigger folder selection on Ctrl+O', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);
			vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue('/selected/via/shortcut');

			const { container } = render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				expect(screen.getByRole('dialog')).toBeInTheDocument();
			});

			// Keyboard events are handled by the wrapper div around Modal
			const wrapper = container.firstChild as HTMLElement;
			await act(async () => {
				fireEvent.keyDown(wrapper, { key: 'O', ctrlKey: true });
			});

			expect(window.maestro.dialog.selectFolder).toHaveBeenCalled();
		});

		it('should create agent on Cmd+Enter when form is valid', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			const { container } = render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				expect(screen.getByPlaceholderText('Select directory...')).toBeInTheDocument();
			});

			const nameInput = screen.getByLabelText('Agent Name');
			fireEvent.change(nameInput, { target: { value: 'Test Session' } });

			const dirInput = screen.getByPlaceholderText('Select directory...');
			fireEvent.change(dirInput, { target: { value: '/my/project' } });

			// Keyboard events are handled by the wrapper div around Modal
			const wrapper = container.firstChild as HTMLElement;
			await act(async () => {
				fireEvent.keyDown(wrapper, { key: 'Enter', metaKey: true });
			});

			expect(onCreate).toHaveBeenCalled();
		});

		it('should not create agent on Cmd+Enter when form is invalid', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				expect(screen.getByRole('dialog')).toBeInTheDocument();
			});

			const modal = screen.getByRole('dialog');
			await act(async () => {
				fireEvent.keyDown(modal, { key: 'Enter', metaKey: true });
			});

			expect(onCreate).not.toHaveBeenCalled();
		});

		it('should not create agent on Cmd+Enter when instance name is missing', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				expect(screen.getByPlaceholderText('Select directory...')).toBeInTheDocument();
			});

			// Only set working directory, not instance name
			const dirInput = screen.getByPlaceholderText('Select directory...');
			fireEvent.change(dirInput, { target: { value: '/my/project' } });

			const modal = screen.getByRole('dialog');
			await act(async () => {
				fireEvent.keyDown(modal, { key: 'Enter', metaKey: true });
			});

			expect(onCreate).not.toHaveBeenCalled();
		});
	});

	describe('Layer stack integration', () => {
		it('should register layer when modal opens', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			expect(mockRegisterLayer).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'modal',
					blocksLowerLayers: true,
					capturesFocus: true,
					focusTrap: 'strict',
					ariaLabel: 'Create New Agent',
				})
			);
		});

		it('should unregister layer when modal closes', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			const { rerender } = render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			expect(mockRegisterLayer).toHaveBeenCalled();

			rerender(
				<NewInstanceModal
					isOpen={false}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-new-instance-123');
		});

		it('should update layer handler when onClose changes', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			const { rerender } = render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			const newOnClose = vi.fn();
			rerender(
				<NewInstanceModal
					isOpen={true}
					onClose={newOnClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			// useModalLayer wraps onEscape in a stable closure (`() => onEscapeRef.current()`)
			// to avoid re-registering the layer on every render. The handler still routes to
			// the latest onClose via ref - we just verify update was called with our layer id.
			expect(mockUpdateLayerHandler).toHaveBeenCalledWith(
				'layer-new-instance-123',
				expect.any(Function)
			);
			// Trigger the latest registered escape handler and verify it calls the new onClose
			const lastCall =
				mockUpdateLayerHandler.mock.calls[mockUpdateLayerHandler.mock.calls.length - 1];
			(lastCall[1] as () => void)();
			expect(newOnClose).toHaveBeenCalledTimes(1);
		});
	});

	describe('Custom agent paths', () => {
		it('should prefer the validated local custom path over stale stored config', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({
					id: 'codex',
					name: 'Codex',
					binaryName: 'codex',
					path: '/detected/codex',
					customPath: '/current/codex',
				}),
			]);
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
				customPath: '/stale/codex',
			});

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			await waitFor(() => {
				expect(screen.getByText('Codex')).toBeInTheDocument();
			});
			fireEvent.click(screen.getByText('Codex'));

			await waitFor(() => {
				expect(screen.getByDisplayValue('/current/codex')).toBeInTheDocument();
			});
			expect(screen.queryByDisplayValue('/stale/codex')).not.toBeInTheDocument();
		});

		it('should display path input for Claude Code agent', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			// Wait for agents to load, then click to expand
			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});
			fireEvent.click(screen.getByText('Claude Code'));

			// Path section now shows "Path" label (not "Custom Path (optional)")
			await waitFor(() => {
				expect(screen.getByPlaceholderText('/path/to/claude')).toBeInTheDocument();
				expect(screen.getByText('Path')).toBeInTheDocument();
			});
		});

		it('should pass custom path to onCreate when creating agent', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			// Wait for agents to load, then click to expand
			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});
			fireEvent.click(screen.getByText('Claude Code'));

			await waitFor(() => {
				expect(screen.getByPlaceholderText('/path/to/claude')).toBeInTheDocument();
			});

			// Set custom path
			const customPathInput = screen.getByPlaceholderText('/path/to/claude');
			fireEvent.change(customPathInput, { target: { value: '/custom/path/to/claude' } });

			// Fill in required fields
			openTab('General');
			const nameInput = screen.getByLabelText('Agent Name');
			fireEvent.change(nameInput, { target: { value: 'My Session' } });

			const dirInput = screen.getByPlaceholderText('Select directory...');
			fireEvent.change(dirInput, { target: { value: '/my/project' } });

			// Create agent
			const createButton = screen.getByText('Create Agent');
			await act(async () => {
				fireEvent.click(createButton);
			});

			// Custom path should be passed to onCreate
			expect(onCreate).toHaveBeenCalledWith(
				'claude-code',
				'/my/project',
				'My Session',
				undefined,
				undefined,
				'/custom/path/to/claude',
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				expect.objectContaining({ enabled: false, remoteId: null }),
				undefined,
				undefined,
				undefined, // enableMaestroP unset: API is the default for Claude Code (Adaptive Mode off)
				undefined, // maestroPPath
				undefined, // maestroPMode unset until the user opts into TUI/Dynamic
				true, // retryOnAvailabilityErrors
				true, // retryOnTokenExhaustion
				undefined, // additionalDirectories
				false, // codexAutoResetOnExhaustion: off by default
				'exec', // codexTransport: Standard by default
				undefined, // gatewayUrl: none unless set on the Models tab
				undefined, // runOn: the provider's own model unless chosen on the Models tab
				NO_PEER_GRANTS, // peerGrants: nothing granted unless set on the Peers tab
				undefined // seedExtras: only a form seeded from a group's defaults has any
			);
		});

		it('should enable Create button when custom path is specified for unavailable agent', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: false }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			// Wait for agents to load
			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
				expect(screen.getByText('Not Found')).toBeInTheDocument();
			});

			// Click to expand the unavailable agent
			fireEvent.click(screen.getByText('Claude Code'));

			await waitFor(() => {
				expect(screen.getByPlaceholderText('/path/to/claude')).toBeInTheDocument();
			});

			// Fill in required fields
			openTab('General');
			const nameInput = screen.getByLabelText('Agent Name');
			fireEvent.change(nameInput, { target: { value: 'My Session' } });

			const dirInput = screen.getByPlaceholderText('Select directory...');
			fireEvent.change(dirInput, { target: { value: '/my/project' } });

			// Button should still be disabled because agent is not available
			const createButton = screen.getByText('Create Agent');
			expect(createButton).toBeDisabled();

			// Set custom path
			openTab('Provider');
			const customPathInput = screen.getByPlaceholderText('/path/to/claude');
			fireEvent.change(customPathInput, { target: { value: '/custom/path/to/claude' } });

			// Now button should be enabled because custom path is specified
			await waitFor(() => {
				expect(createButton).not.toBeDisabled();
			});
		});

		it('should select unavailable agent immediately when clicked (to configure custom path)', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: false }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			// Wait for agents to load
			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});

			// Click to expand the unavailable agent
			const option = screen.getByRole('option', { name: /Claude Code/i });
			fireEvent.click(option);

			// Agent should be selected immediately (even though unavailable)
			// This allows user to configure a custom path
			await waitFor(() => {
				expect(option).toHaveAttribute('aria-selected', 'true');
			});

			// Expanded panel should be visible
			await waitFor(() => {
				expect(screen.getByPlaceholderText('/path/to/claude')).toBeInTheDocument();
			});
		});

		it('should call onCreate with custom path for previously unavailable agent', async () => {
			// Agent is unavailable and has no detected path
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: false, path: null }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			// Wait for agents to load
			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});

			// Click to expand and select (clicking selects even unavailable agents now)
			fireEvent.click(screen.getByText('Claude Code'));

			await waitFor(() => {
				expect(screen.getByPlaceholderText('/path/to/claude')).toBeInTheDocument();
			});

			// Set custom path - this makes the Create button enabled
			const customPathInput = screen.getByPlaceholderText('/path/to/claude');
			fireEvent.change(customPathInput, { target: { value: '/custom/bin/claude' } });

			// Fill in required fields
			openTab('General');
			const nameInput = screen.getByLabelText('Agent Name');
			fireEvent.change(nameInput, { target: { value: 'Custom Path Agent' } });

			const dirInput = screen.getByPlaceholderText('Select directory...');
			fireEvent.change(dirInput, { target: { value: '/my/project' } });

			// Create agent
			const createButton = screen.getByText('Create Agent');
			await act(async () => {
				fireEvent.click(createButton);
			});

			// Should pass custom path to onCreate
			expect(onCreate).toHaveBeenCalledWith(
				'claude-code',
				'/my/project',
				'Custom Path Agent',
				undefined,
				undefined,
				'/custom/bin/claude',
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				expect.objectContaining({ enabled: false, remoteId: null }),
				undefined,
				undefined,
				undefined, // enableMaestroP unset: API is the default for Claude Code (Adaptive Mode off)
				undefined, // maestroPPath
				undefined, // maestroPMode unset until the user opts into TUI/Dynamic
				true, // retryOnAvailabilityErrors
				true, // retryOnTokenExhaustion
				undefined, // additionalDirectories
				false, // codexAutoResetOnExhaustion: off by default
				'exec', // codexTransport: Standard by default
				undefined, // gatewayUrl: none unless set on the Models tab
				undefined, // runOn: the provider's own model unless chosen on the Models tab
				NO_PEER_GRANTS, // peerGrants: nothing granted unless set on the Peers tab
				undefined // seedExtras: only a form seeded from a group's defaults has any
			);
		});
	});

	describe('Error handling', () => {
		it('should handle agent detection failure gracefully', async () => {
			vi.mocked(window.maestro.agents.detect).mockRejectedValue(new Error('Detection failed'));
			const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				expect(consoleSpy).toHaveBeenCalledWith(
					'Failed to load agents:',
					undefined,
					expect.any(Error)
				);
			});

			consoleSpy.mockRestore();
		});

		it('should handle agent refresh failure gracefully', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);
			vi.mocked(window.maestro.agents.refresh).mockRejectedValue(new Error('Refresh failed'));
			const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			await waitFor(() => {
				expect(screen.getByTitle('Refresh detection')).toBeInTheDocument();
			});

			const refreshButton = screen.getByTitle('Refresh detection');
			await act(async () => {
				fireEvent.click(refreshButton);
			});

			await waitFor(() => {
				expect(consoleSpy).toHaveBeenCalledWith(
					'Failed to refresh agent:',
					undefined,
					expect.any(Error)
				);
			});

			consoleSpy.mockRestore();
		});
	});

	describe('Styling and theming', () => {
		it('should apply theme colors to modal', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				const title = screen.getByText('Create New Agent');
				expect(title).toHaveStyle({ color: theme.colors.textMain });
			});
		});

		it('should apply success color to Available badge', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			await waitFor(() => {
				const badge = screen.getByText('Available');
				expect(badge).toHaveStyle({ color: theme.colors.success });
			});
		});

		it('should apply error color to Not Found badge', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: false }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			await waitFor(() => {
				const badge = screen.getByText('Not Found');
				expect(badge).toHaveStyle({ color: theme.colors.error });
			});
		});
	});

	describe('Accessibility', () => {
		it('should have proper ARIA attributes on modal', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			const modal = screen.getByRole('dialog');
			expect(modal).toHaveAttribute('aria-modal', 'true');
			expect(modal).toHaveAttribute('aria-label', 'Create New Agent');
		});

		it('should have proper role=option on agent selections', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			await waitFor(() => {
				const options = screen.getAllByRole('option');
				expect(options.length).toBeGreaterThan(0);
			});
		});

		it('should have tabindex=-1 on modal container', () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			const modal = screen.getByRole('dialog');
			expect(modal).toHaveAttribute('tabIndex', '-1');
		});

		it('should have tabindex=0 for available claude-code option', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			await waitFor(() => {
				const option = screen.getByRole('option', { name: /Claude Code/i });
				expect(option).toHaveAttribute('tabIndex', '0');
			});
		});

		it('should have tabindex=-1 for unsupported agents (coming soon)', async () => {
			// Note: tabIndex is based on isSupported (in SUPPORTED_AGENTS), not availability
			// gemini-cli is not in SUPPORTED_AGENTS so it should have tabIndex=-1
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'gemini-cli', name: 'Gemini CLI', available: false }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			await waitFor(() => {
				const option = screen.getByRole('option', { name: /Gemini CLI/i });
				expect(option).toHaveAttribute('tabIndex', '-1');
			});
		});
	});

	describe('Multiple agents display', () => {
		it('should display multiple agents correctly', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
				createAgentConfig({ id: 'openai-codex', name: 'OpenAI Codex', available: false }),
				createAgentConfig({ id: 'gemini-cli', name: 'Gemini CLI', available: false }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			// Two of the three are unavailable, so ask past the default filter.
			await showAllProviders();

			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
				expect(screen.getByText('OpenAI Codex')).toBeInTheDocument();
				expect(screen.getByText('Gemini CLI')).toBeInTheDocument();
			});
		});

		it('should display correct badge for each agent type', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
				createAgentConfig({ id: 'openai-codex', name: 'OpenAI Codex', available: false }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			// The Coming Soon row only exists past the default filter.
			await showAllProviders();

			await waitFor(() => {
				expect(screen.getByText('Available')).toBeInTheDocument();
				expect(screen.getByText('Coming Soon')).toBeInTheDocument();
			});
		});
	});

	describe('PATH display in debug info', () => {
		it('should split and display PATH entries correctly', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: false }),
			]);
			vi.mocked(window.maestro.agents.refresh).mockResolvedValue({
				agents: [createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: false })],
				debugInfo: {
					agentId: 'claude-code',
					available: false,
					path: null,
					binaryName: 'claude',
					envPath: '/usr/bin:/usr/local/bin:/home/user/.local/bin',
					homeDir: '/home/user',
					platform: 'linux',
					whichCommand: 'which',
					error: null,
				},
			});

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			await waitFor(() => {
				expect(screen.getByTitle('Refresh detection')).toBeInTheDocument();
			});

			const refreshButton = screen.getByTitle('Refresh detection');
			await act(async () => {
				fireEvent.click(refreshButton);
			});

			await waitFor(() => {
				expect(screen.getByText('/usr/bin')).toBeInTheDocument();
				expect(screen.getByText('/usr/local/bin')).toBeInTheDocument();
				expect(screen.getByText('/home/user/.local/bin')).toBeInTheDocument();
			});
		});
	});

	describe('model autocomplete', () => {
		it('should load models when expanding an agent with supportsModelSelection', async () => {
			const agentWithModelSelection = createAgentConfig({
				id: 'opencode',
				name: 'OpenCode',
				available: true,
				capabilities: {
					supportsResume: false,
					supportsReadOnlyMode: false,
					supportsJsonOutput: true,
					supportsSessionId: true,
					supportsImageInput: false,
					supportsSlashCommands: false,
					supportsSessionStorage: false,
					supportsCostTracking: false,
					supportsUsageStats: true,
					supportsBatchMode: true,
					supportsStreaming: true,
					supportsResultMessages: true,
					supportsModelSelection: true,
				},
				configOptions: [
					{
						key: 'model',
						type: 'text',
						label: 'Model',
						description: 'Model to use',
						default: '',
					},
				],
			});

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([agentWithModelSelection]);
			vi.mocked(window.maestro.agents.getModels).mockResolvedValue([
				'ollama/qwen3:8b',
				'anthropic/claude-sonnet-4-20250514',
				'opencode/gpt-5-nano',
			]);
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			// Wait for agents to load and click to expand
			await waitFor(() => {
				expect(screen.getByText('OpenCode')).toBeInTheDocument();
			});

			// Click to expand the agent
			const agentRow = screen.getByText('OpenCode').closest('[role="option"]');
			if (agentRow) {
				await act(async () => {
					fireEvent.click(agentRow);
				});
			}

			// Should call getModels when expanding
			await waitFor(() => {
				expect(window.maestro.agents.getModels).toHaveBeenCalledWith('opencode', false);
			});
		});

		it('should show model count when models are loaded', async () => {
			const agentWithModelSelection = createAgentConfig({
				id: 'opencode',
				name: 'OpenCode',
				available: true,
				capabilities: {
					supportsResume: false,
					supportsReadOnlyMode: false,
					supportsJsonOutput: true,
					supportsSessionId: true,
					supportsImageInput: false,
					supportsSlashCommands: false,
					supportsSessionStorage: false,
					supportsCostTracking: false,
					supportsUsageStats: true,
					supportsBatchMode: true,
					supportsStreaming: true,
					supportsResultMessages: true,
					supportsModelSelection: true,
				},
				configOptions: [
					{
						key: 'model',
						type: 'text',
						label: 'Model',
						description: 'Model to use',
						default: '',
					},
				],
			});

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([agentWithModelSelection]);
			vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['model1', 'model2', 'model3']);
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			// Wait for agents to load and click to expand
			await waitFor(() => {
				expect(screen.getByText('OpenCode')).toBeInTheDocument();
			});

			// Click to expand the agent
			const agentRow = screen.getByText('OpenCode').closest('[role="option"]');
			if (agentRow) {
				await act(async () => {
					fireEvent.click(agentRow);
				});
			}

			// Should show model count
			await waitFor(() => {
				expect(screen.getByText('3 models available')).toBeInTheDocument();
			});
		});

		it('should not load models for agents without supportsModelSelection', async () => {
			const agentWithoutModelSelection = createAgentConfig({
				id: 'claude-code',
				name: 'Claude Code',
				available: true,
				capabilities: {
					supportsResume: true,
					supportsReadOnlyMode: true,
					supportsJsonOutput: true,
					supportsSessionId: true,
					supportsImageInput: true,
					supportsSlashCommands: true,
					supportsSessionStorage: true,
					supportsCostTracking: true,
					supportsUsageStats: true,
					supportsBatchMode: true,
					supportsStreaming: true,
					supportsResultMessages: true,
					supportsModelSelection: false,
				},
			});

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([agentWithoutModelSelection]);
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			// Wait for agents to load and click to expand
			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});

			// Click to expand the agent
			const agentRow = screen.getByText('Claude Code').closest('[role="option"]');
			if (agentRow) {
				await act(async () => {
					fireEvent.click(agentRow);
				});
			}

			// Should NOT call getModels
			expect(window.maestro.agents.getModels).not.toHaveBeenCalled();
		});

		it('should show refresh button for model input when supportsModelSelection', async () => {
			const agentWithModelSelection = createAgentConfig({
				id: 'opencode',
				name: 'OpenCode',
				available: true,
				capabilities: {
					supportsResume: false,
					supportsReadOnlyMode: false,
					supportsJsonOutput: true,
					supportsSessionId: true,
					supportsImageInput: false,
					supportsSlashCommands: false,
					supportsSessionStorage: false,
					supportsCostTracking: false,
					supportsUsageStats: true,
					supportsBatchMode: true,
					supportsStreaming: true,
					supportsResultMessages: true,
					supportsModelSelection: true,
				},
				configOptions: [
					{
						key: 'model',
						type: 'text',
						label: 'Model',
						description: 'Model to use',
						default: '',
					},
				],
			});

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([agentWithModelSelection]);
			vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['model1']);
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			// Wait for agents to load and click to expand
			await waitFor(() => {
				expect(screen.getByText('OpenCode')).toBeInTheDocument();
			});

			// Click to expand the agent
			const agentRow = screen.getByText('OpenCode').closest('[role="option"]');
			if (agentRow) {
				await act(async () => {
					fireEvent.click(agentRow);
				});
			}

			// Should show refresh button with correct title
			await waitFor(() => {
				expect(screen.getByTitle('Refresh available models')).toBeInTheDocument();
			});
		});
	});

	describe('Agent Duplication (sourceSession)', () => {
		it('should pre-fill all fields when sourceSession is provided', async () => {
			const sourceSession: Session = {
				id: 'session-1',
				name: 'Original Agent',
				toolType: 'claude-code',
				cwd: '/test/project',
				projectRoot: '/test/project',
				fullPath: '/test/project',
				state: 'idle',
				inputMode: 'ai',
				aiPid: 12345,
				terminalPid: 12346,
				port: 3000,
				aiTabs: [],
				activeTabId: 'tab-1',
				closedTabHistory: [],
				shellLogs: [],
				executionQueue: [],
				contextUsage: 0,
				workLog: [],
				isGitRepo: false,
				changedFiles: [],
				fileTree: [],
				fileExplorerExpanded: [],
				fileExplorerScrollPos: 0,
				isLive: false,
				nudgeMessage: 'Custom system prompt',
				customPath: '/usr/local/bin/claude',
				customArgs: '--verbose',
				customEnvVars: { DEBUG: 'true' },
				customModel: 'claude-opus-4',
				customContextWindow: 200000,
			} as Session;

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
					sourceSession={sourceSession}
				/>
			);

			await waitFor(() => {
				const nameInput = screen.getByLabelText('Agent Name') as HTMLInputElement;
				expect(nameInput.value).toBe('Original Agent (Copy)');
			});

			const dirInput = screen.getByPlaceholderText('Select directory...') as HTMLInputElement;
			expect(dirInput.value).toBe('/test/project');
		});

		it('should allow modifying pre-filled fields', async () => {
			const sourceSession: Session = {
				id: 'session-1',
				name: 'Original Agent',
				toolType: 'claude-code',
				cwd: '/test/project',
				projectRoot: '/test/project',
				fullPath: '/test/project',
				state: 'idle',
				inputMode: 'ai',
				aiPid: 12345,
				terminalPid: 12346,
				port: 3000,
				aiTabs: [],
				activeTabId: 'tab-1',
				closedTabHistory: [],
				shellLogs: [],
				executionQueue: [],
				contextUsage: 0,
				workLog: [],
				isGitRepo: false,
				changedFiles: [],
				fileTree: [],
				fileExplorerExpanded: [],
				fileExplorerScrollPos: 0,
				isLive: false,
			} as Session;

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
					sourceSession={sourceSession}
				/>
			);

			await waitFor(() => {
				const nameInput = screen.getByLabelText('Agent Name') as HTMLInputElement;
				expect(nameInput.value).toBe('Original Agent (Copy)');
			});

			const nameInput = screen.getByLabelText('Agent Name') as HTMLInputElement;
			await act(async () => {
				fireEvent.change(nameInput, { target: { value: 'Modified Name' } });
			});

			expect(nameInput.value).toBe('Modified Name');
		});

		it('should not pre-fill when sourceSession is not provided', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				const nameInput = screen.getByLabelText('Agent Name') as HTMLInputElement;
				expect(nameInput.value).toBe('');
			});

			const dirInput = screen.getByPlaceholderText('Select directory...') as HTMLInputElement;
			expect(dirInput.value).toBe('');
		});

		it('should pre-fill custom arguments when duplicating', async () => {
			const sourceSession: Session = {
				id: 'session-1',
				name: 'Original Agent',
				toolType: 'claude-code',
				cwd: '/test/project',
				projectRoot: '/test/project',
				fullPath: '/test/project',
				state: 'idle',
				inputMode: 'ai',
				aiPid: 12345,
				terminalPid: 12346,
				port: 3000,
				aiTabs: [],
				activeTabId: 'tab-1',
				closedTabHistory: [],
				shellLogs: [],
				executionQueue: [],
				contextUsage: 0,
				workLog: [],
				isGitRepo: false,
				changedFiles: [],
				fileTree: [],
				fileExplorerExpanded: [],
				fileExplorerScrollPos: 0,
				isLive: false,
				customArgs: '--model=opus --verbose',
			} as Session;

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
					sourceSession={sourceSession}
				/>
			);

			await waitFor(() => {
				const nameInput = screen.getByLabelText('Agent Name') as HTMLInputElement;
				expect(nameInput.value).toBe('Original Agent (Copy)');
			});

			// Verify customArgs were pre-filled (internal state test)
			// The actual visibility depends on the agent being expanded, which we also set
			expect(sourceSession.customArgs).toBe('--model=opus --verbose');
		});

		it('forwards source.customEffort through to onCreate when duplicating a Codex agent', async () => {
			// Positive coverage for the customEffort plumbing (#755) and the
			// duplicate-flow merge fix (CodeRabbit review): the picked effort must
			// flow through as the trailing customEffort arg, not just `undefined`.
			const sourceSession: Session = {
				id: 'session-codex',
				name: 'Codex Agent',
				toolType: 'codex',
				cwd: '/home/testuser/proj',
				projectRoot: '/home/testuser/proj',
				fullPath: '/home/testuser/proj',
				state: 'idle',
				inputMode: 'ai',
				aiPid: 0,
				terminalPid: 0,
				port: 3000,
				aiTabs: [],
				activeTabId: 'tab-1',
				closedTabHistory: [],
				shellLogs: [],
				executionQueue: [],
				contextUsage: 0,
				workLog: [],
				isGitRepo: false,
				changedFiles: [],
				fileTree: [],
				fileExplorerExpanded: [],
				fileExplorerScrollPos: 0,
				isLive: false,
				customEffort: 'xhigh',
			} as Session;

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({
					id: 'codex',
					name: 'OpenAI Codex',
					available: true,
					configOptions: [
						{
							key: 'reasoningEffort',
							type: 'select',
							label: 'Reasoning Effort',
							default: '',
							options: ['', 'minimal', 'low', 'medium', 'high', 'xhigh'],
						},
					],
				}),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
					sourceSession={sourceSession}
				/>
			);

			await waitFor(() => {
				const nameInput = screen.getByLabelText('Agent Name') as HTMLInputElement;
				expect(nameInput.value).toBe('Codex Agent (Copy)');
			});

			await act(async () => {
				fireEvent.click(screen.getByText('Create Agent'));
			});

			// 13th positional arg is customEffort. assert it's 'xhigh', not undefined.
			expect(onCreate).toHaveBeenCalled();
			const args = onCreate.mock.calls[0];
			expect(args[12]).toBe('xhigh');
		});

		it('forwards source.groupId through to onCreate so duplicates inherit the group (issue #827)', async () => {
			const sourceSession: Session = {
				id: 'session-grouped',
				name: 'Grouped Agent',
				toolType: 'claude-code',
				cwd: '/test/project',
				projectRoot: '/test/project',
				fullPath: '/test/project',
				state: 'idle',
				inputMode: 'ai',
				aiPid: 0,
				terminalPid: 0,
				port: 3000,
				aiTabs: [],
				activeTabId: 'tab-1',
				closedTabHistory: [],
				shellLogs: [],
				executionQueue: [],
				contextUsage: 0,
				workLog: [],
				isGitRepo: false,
				changedFiles: [],
				fileTree: [],
				fileExplorerExpanded: [],
				fileExplorerScrollPos: 0,
				isLive: false,
				groupId: 'group-abc',
			} as Session;

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
					sourceSession={sourceSession}
				/>
			);

			await waitFor(() => {
				const nameInput = screen.getByLabelText('Agent Name') as HTMLInputElement;
				expect(nameInput.value).toBe('Grouped Agent (Copy)');
			});

			await act(async () => {
				fireEvent.click(screen.getByText('Create Agent'));
			});

			// 14th positional arg (index 13) is groupId; must equal source.groupId so
			// the duplicate lands in the same group as the original.
			expect(onCreate).toHaveBeenCalled();
			const args = onCreate.mock.calls[0];
			expect(args[13]).toBe('group-abc');
		});

		it('does not clobber the user-typed name when sourceSession reference changes (issue #827)', async () => {
			// Regression: AppModals derives sourceSession from a useMemo over the
			// sessions array. Any unrelated sessions update produces a new object
			// reference. The pre-fill effect must depend on sourceSession?.id, not
			// the full object, otherwise it re-runs and overwrites whatever the
			// user has typed in the name field.
			const baseSession: Session = {
				id: 'session-1',
				name: 'Original Agent',
				toolType: 'claude-code',
				cwd: '/test/project',
				projectRoot: '/test/project',
				fullPath: '/test/project',
				state: 'idle',
				inputMode: 'ai',
				aiPid: 0,
				terminalPid: 0,
				port: 3000,
				aiTabs: [],
				activeTabId: 'tab-1',
				closedTabHistory: [],
				shellLogs: [],
				executionQueue: [],
				contextUsage: 0,
				workLog: [],
				isGitRepo: false,
				changedFiles: [],
				fileTree: [],
				fileExplorerExpanded: [],
				fileExplorerScrollPos: 0,
				isLive: false,
			} as Session;

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			const { rerender } = render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
					sourceSession={baseSession}
				/>
			);

			await waitFor(() => {
				const nameInput = screen.getByLabelText('Agent Name') as HTMLInputElement;
				expect(nameInput.value).toBe('Original Agent (Copy)');
			});

			// User edits the pre-filled name.
			const nameInput = screen.getByLabelText('Agent Name') as HTMLInputElement;
			await act(async () => {
				fireEvent.change(nameInput, { target: { value: 'My New Agent' } });
			});
			expect(nameInput.value).toBe('My New Agent');

			// Parent re-renders with a NEW object reference for the same source
			// session (simulating the upstream useMemo recomputing when the
			// sessions array updates). The user-typed value must be preserved.
			await act(async () => {
				rerender(
					<NewInstanceModal
						isOpen={true}
						onClose={onClose}
						onCreate={onCreate}
						theme={theme}
						existingSessions={[]}
						sourceSession={{ ...baseSession }}
					/>
				);
			});

			expect((screen.getByLabelText('Agent Name') as HTMLInputElement).value).toBe('My New Agent');
		});

		it('should display SSH selector even when no agent is selected', async () => {
			// This tests the bug where SSH section was hidden when no agents were available
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: false }),
			]);
			vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
				success: true,
				configs: [
					{
						id: 'remote-1',
						name: 'Test Server',
						host: 'test.example.com',
						port: 22,
						username: 'testuser',
						privateKeyPath: '/path/to/key',
						enabled: true,
					},
				],
			});

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('SSH');

			// Wait for the SSH selector to appear even though no agent is available
			await waitFor(() => {
				expect(screen.getByText('SSH Remote Execution')).toBeInTheDocument();
				expect(screen.getByText('Local Execution')).toBeInTheDocument();
			});
		});

		it('should transfer pending SSH config when agent is selected', async () => {
			// This tests that SSH config selected before agent selection transfers to the agent
			// We verify that the _pending_ config is used by checking that agents.detect is called
			// with the SSH remote ID (which happens when agentSshRemoteConfigs['_pending_'] is set)
			const detectMock = vi.mocked(window.maestro.agents.detect);

			// Initial detection returns agents
			detectMock.mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: false }),
				createAgentConfig({ id: 'opencode', name: 'OpenCode', available: true }),
			]);
			vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
				success: true,
				configs: [
					{
						id: 'remote-1',
						name: 'Test Server',
						host: 'test.example.com',
						port: 22,
						username: 'testuser',
						privateKeyPath: '/path/to/key',
						enabled: true,
					},
				],
			});
			// Mock fs.stat for remote path validation
			vi.mocked(window.maestro.fs.stat).mockResolvedValue({
				size: 4096,
				createdAt: '2024-01-01T00:00:00.000Z',
				modifiedAt: '2024-01-15T12:30:00.000Z',
				isDirectory: true,
				isFile: false,
			});

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('SSH');

			// Wait for SSH selector (should appear immediately since we have SSH configs)
			await waitFor(() => {
				expect(screen.getByText('SSH Remote Execution')).toBeInTheDocument();
			});

			// Record initial detect call count
			const initialCallCount = detectMock.mock.calls.length;

			// Select the SSH remote BEFORE selecting an agent
			const dropdown = screen.getByRole('combobox');
			fireEvent.change(dropdown, { target: { value: 'remote-1' } });

			// Verify agents.detect was called with the SSH remote ID
			// This confirms that the _pending_ config was set correctly
			await waitFor(() => {
				expect(detectMock.mock.calls.length).toBeGreaterThan(initialCallCount);
				expect(detectMock).toHaveBeenCalledWith('remote-1');
			});

			// Now select the available agent (opencode)
			openTab('Provider');
			await waitFor(() => {
				expect(screen.getByText('OpenCode')).toBeInTheDocument();
			});
			const openCodeOption = screen.getByRole('option', { name: /OpenCode/i });
			await act(async () => {
				fireEvent.click(openCodeOption);
			});

			// Wait for the agent to be selected (indicated by being aria-selected=true)
			await waitFor(() => {
				// The OpenCode option should now be selected
				const options = screen.getAllByRole('option');
				const openCodeOpt = options.find((opt) => opt.textContent?.includes('OpenCode'));
				expect(openCodeOpt).toHaveAttribute('aria-selected', 'true');
			});

			// After selecting an agent, fill in required fields
			openTab('General');
			const nameInput = screen.getByLabelText('Agent Name');
			fireEvent.change(nameInput, { target: { value: 'SSH Test' } });

			// Find the Working Directory input and fill it
			// (Skip the placeholder check - JSDOM doesn't reliably update controlled select state)
			const dirInput = screen.getByLabelText('Working Directory');
			fireEvent.change(dirInput, { target: { value: '/test/path' } });

			// Wait for remote path validation to complete (debounced 300ms)
			// This validates the path exists on the remote and enables the Create button
			await waitFor(
				() => {
					expect(screen.getByText('Directory found on test.example.com')).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			// The core verification: clicking Create should pass the SSH config that was pending
			const createButton = screen.getByText('Create Agent');
			await act(async () => {
				fireEvent.click(createButton);
			});

			// Should have passed the SSH config that was selected while agent was not yet selected
			// This proves the _pending_ config was transferred to the agent on selection.
			// workingDirOverride should be the working directory path since SSH is enabled
			// (the Working Directory field contains a remote path when SSH is on).
			expect(onCreate).toHaveBeenCalledWith(
				'opencode',
				'/test/path',
				'SSH Test',
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				expect.objectContaining({
					enabled: true,
					remoteId: 'remote-1',
					syncHistory: false,
					workingDirOverride: '/test/path',
				}),
				undefined,
				undefined,
				undefined, // enableMaestroP
				undefined, // maestroPPath
				undefined, // maestroPMode
				true, // retryOnAvailabilityErrors
				true, // retryOnTokenExhaustion
				undefined, // additionalDirectories
				false, // codexAutoResetOnExhaustion: off by default
				'exec', // codexTransport: Standard by default
				undefined, // gatewayUrl: none unless set on the Models tab
				undefined, // runOn: the provider's own model unless chosen on the Models tab
				NO_PEER_GRANTS, // peerGrants: nothing granted unless set on the Peers tab
				undefined // seedExtras: only a form seeded from a group's defaults has any
			);
		});

		it('should pre-fill SSH remote configuration when duplicating', async () => {
			const sourceSession: Session = {
				id: 'session-1',
				name: 'SSH Agent',
				toolType: 'claude-code',
				cwd: '/remote/project',
				projectRoot: '/remote/project',
				fullPath: '/remote/project',
				state: 'idle',
				inputMode: 'ai',
				aiPid: 12345,
				terminalPid: 12346,
				port: 3000,
				aiTabs: [],
				activeTabId: 'tab-1',
				closedTabHistory: [],
				shellLogs: [],
				executionQueue: [],
				contextUsage: 0,
				workLog: [],
				isGitRepo: false,
				changedFiles: [],
				fileTree: [],
				fileExplorerExpanded: [],
				fileExplorerScrollPos: 0,
				isLive: false,
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/custom/path',
				},
			} as Session;

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
					sourceSession={sourceSession}
				/>
			);

			await waitFor(() => {
				const nameInput = screen.getByLabelText('Agent Name') as HTMLInputElement;
				expect(nameInput.value).toBe('SSH Agent (Copy)');
			});

			// Verify SSH config was pre-filled (internal state test)
			expect(sourceSession.sessionSshRemoteConfig?.enabled).toBe(true);
			expect(sourceSession.sessionSshRemoteConfig?.remoteId).toBe('remote-1');
			expect(sourceSession.sessionSshRemoteConfig?.workingDirOverride).toBe('/custom/path');
		});

		it('should re-detect agents when SSH remote selection changes', async () => {
			const detectMock = vi.mocked(window.maestro.agents.detect);

			// Initial detection returns local agents
			detectMock.mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
				createAgentConfig({ id: 'opencode', name: 'OpenCode', available: true }),
			]);

			vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
				success: true,
				configs: [
					{
						id: 'remote-1',
						name: 'Test Server',
						host: 'test.example.com',
						port: 22,
						username: 'testuser',
						privateKeyPath: '/path/to/key',
						enabled: true,
					},
				],
			});

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('SSH');

			// Wait for initial detection
			await waitFor(() => {
				expect(detectMock).toHaveBeenCalledWith(undefined);
			});

			// Record the call count after initial detection
			const initialCallCount = detectMock.mock.calls.length;

			// Mock remote detection (claude available, opencode not)
			detectMock.mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
				createAgentConfig({ id: 'opencode', name: 'OpenCode', available: false }),
			]);

			// Wait for SSH selector to be available
			await waitFor(() => {
				expect(screen.getByText('SSH Remote Execution')).toBeInTheDocument();
			});

			// Select the SSH remote using the combobox (select element)
			// The SshRemoteSelector uses a <select> with <option value="local">Local Execution</option>
			const dropdown = screen.getByRole('combobox');
			fireEvent.change(dropdown, { target: { value: 'remote-1' } });

			// Detection should be called again with the SSH remote ID
			await waitFor(() => {
				expect(detectMock.mock.calls.length).toBeGreaterThan(initialCallCount);
				expect(detectMock).toHaveBeenCalledWith('remote-1');
			});
		});

		it('should set workingDirOverride to the remote path when creating SSH agent (regression: SSH terminal cwd)', async () => {
			// Regression test: when SSH is enabled the "Working Directory" field contains a remote
			// path. This path MUST flow into sessionSshRemoteConfig.workingDirOverride so that
			// SSH terminals `cd` to the correct directory on the remote host. Without this,
			// terminals would drop into the remote home directory instead.
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);
			vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
				success: true,
				configs: [
					{
						id: 'remote-1',
						name: 'Dev Server',
						host: 'dev.example.com',
						port: 22,
						username: 'devuser',
						privateKeyPath: '/path/to/key',
						enabled: true,
					},
				],
			});
			vi.mocked(window.maestro.fs.stat).mockResolvedValue({
				size: 4096,
				createdAt: '2024-01-01T00:00:00.000Z',
				modifiedAt: '2024-01-15T12:30:00.000Z',
				isDirectory: true,
				isFile: false,
			});

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('SSH');

			// Wait for agents and SSH selector to load
			await waitFor(() => {
				expect(screen.getByText('SSH Remote Execution')).toBeInTheDocument();
			});

			// Select SSH remote
			const dropdown = screen.getByRole('combobox');
			fireEvent.change(dropdown, { target: { value: 'remote-1' } });

			// Select agent
			openTab('Provider');
			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});
			const agentOption = screen.getByRole('option', { name: /Claude Code/i });
			await act(async () => {
				fireEvent.click(agentOption);
			});

			// Fill in name and remote working directory
			openTab('General');
			fireEvent.change(screen.getByLabelText('Agent Name'), {
				target: { value: 'Remote Agent' },
			});
			fireEvent.change(screen.getByLabelText('Working Directory'), {
				target: { value: '/home/devuser/my-project' },
			});

			// Wait for remote path validation
			await waitFor(
				() => {
					expect(screen.getByText('Directory found on dev.example.com')).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			// Create the agent
			await act(async () => {
				fireEvent.click(screen.getByText('Create Agent'));
			});

			// The critical assertion: workingDirOverride MUST match the remote path
			expect(onCreate).toHaveBeenCalledWith(
				'claude-code',
				'/home/devuser/my-project',
				'Remote Agent',
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				expect.objectContaining({
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/home/devuser/my-project',
				}),
				undefined,
				undefined,
				undefined, // enableMaestroP unset: API is the default for Claude Code (Adaptive Mode off)
				undefined, // maestroPPath
				undefined, // maestroPMode unset until the user opts into TUI/Dynamic
				true, // retryOnAvailabilityErrors
				true, // retryOnTokenExhaustion
				undefined, // additionalDirectories
				false, // codexAutoResetOnExhaustion: off by default
				'exec', // codexTransport: Standard by default
				undefined, // gatewayUrl: none unless set on the Models tab
				undefined, // runOn: the provider's own model unless chosen on the Models tab
				NO_PEER_GRANTS, // peerGrants: nothing granted unless set on the Peers tab
				undefined // seedExtras: only a form seeded from a group's defaults has any
			);
		});

		it('keeps a home-relative remote path verbatim when SSH is enabled (never expands it against the LOCAL home)', async () => {
			// `~/git-projects` on an SSH agent is the REMOTE user's home. Expanding it
			// locally produced `/Users/<local>/git-projects`, which validated green here
			// (the validator stats the raw text on the remote) and then did not exist on
			// the host the agent started on. The remote shell is the only thing that can
			// expand it, and every remote cd/ls/stat renders it as "$HOME/git-projects".
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);
			vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
				success: true,
				configs: [
					{
						id: 'remote-1',
						name: 'Dev Server',
						host: 'dev.example.com',
						port: 22,
						username: 'devuser',
						privateKeyPath: '/path/to/key',
						enabled: true,
					},
				],
			});
			vi.mocked(window.maestro.fs.stat).mockResolvedValue({
				size: 4096,
				createdAt: '2024-01-01T00:00:00.000Z',
				modifiedAt: '2024-01-15T12:30:00.000Z',
				isDirectory: true,
				isFile: false,
			});

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('SSH');

			await waitFor(() => {
				expect(screen.getByText('SSH Remote Execution')).toBeInTheDocument();
			});
			fireEvent.change(screen.getByRole('combobox'), { target: { value: 'remote-1' } });
			openTab('Provider');
			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});
			await act(async () => {
				fireEvent.click(screen.getByRole('option', { name: /Claude Code/i }));
			});

			openTab('General');
			fireEvent.change(screen.getByLabelText('Agent Name'), {
				target: { value: 'Remote Agent' },
			});
			fireEvent.change(screen.getByLabelText('Working Directory'), {
				target: { value: '~/git-projects' },
			});
			await waitFor(
				() => {
					expect(screen.getByText('Directory found on dev.example.com')).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			await act(async () => {
				fireEvent.click(screen.getByText('Create Agent'));
			});

			expect(onCreate).toHaveBeenCalledTimes(1);
			const [, cwd, , , , , , , , , , sshConfig] = onCreate.mock.calls[0];
			expect(cwd).toBe('~/git-projects');
			expect(sshConfig).toEqual(
				expect.objectContaining({
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '~/git-projects',
				})
			);
		});

		it('derives the duplicate workingDirOverride from the directory typed, not from the source agent', async () => {
			// Duplicating an SSH agent and changing its directory used to carry the
			// SOURCE agent's override into the copy: the new agent then started in the
			// typed directory while its terminals, git calls and file tree were pinned
			// to the old one. The field is prefilled with the source's remote directory
			// and whatever is on screen at Create is the one source for both values.
			const sourceSession: Session = {
				id: 'session-1',
				name: 'SSH Agent',
				toolType: 'claude-code',
				cwd: '/home/devuser/project',
				projectRoot: '/home/devuser/project',
				fullPath: '/home/devuser/project',
				state: 'idle',
				inputMode: 'ai',
				aiPid: 12345,
				terminalPid: 12346,
				port: 3000,
				aiTabs: [],
				activeTabId: 'tab-1',
				closedTabHistory: [],
				shellLogs: [],
				executionQueue: [],
				contextUsage: 0,
				workLog: [],
				isGitRepo: false,
				changedFiles: [],
				fileTree: [],
				fileExplorerExpanded: [],
				fileExplorerScrollPos: 0,
				isLive: false,
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/explicit/override/path',
				},
			} as Session;

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);
			vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
				success: true,
				configs: [
					{
						id: 'remote-1',
						name: 'Dev Server',
						host: 'dev.example.com',
						port: 22,
						username: 'devuser',
						privateKeyPath: '/path/to/key',
						enabled: true,
					},
				],
			});
			vi.mocked(window.maestro.fs.stat).mockResolvedValue({
				size: 4096,
				createdAt: '2024-01-01T00:00:00.000Z',
				modifiedAt: '2024-01-15T12:30:00.000Z',
				isDirectory: true,
				isFile: false,
			});

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
					sourceSession={sourceSession}
				/>
			);

			// The field shows the directory the source agent actually runs in on the
			// remote (its override), not the placeholder in `cwd`.
			await waitFor(() => {
				const dirInput = screen.getByLabelText('Working Directory') as HTMLInputElement;
				expect(dirInput.value).toBe('/explicit/override/path');
			});

			fireEvent.change(screen.getByLabelText('Working Directory'), {
				target: { value: '/home/devuser/new-project' },
			});
			await waitFor(
				() => {
					expect(screen.getByText(/Directory found/)).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			await act(async () => {
				fireEvent.click(screen.getByText('Create Agent'));
			});

			expect(onCreate).toHaveBeenCalledTimes(1);
			const [, cwd, , , , , , , , , , sshConfig] = onCreate.mock.calls[0];
			expect(cwd).toBe('/home/devuser/new-project');
			expect(sshConfig).toEqual(
				expect.objectContaining({
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/home/devuser/new-project',
				})
			);
		});

		it('should preserve explicit workingDirOverride over working directory when duplicating SSH agent', async () => {
			// When duplicating a session that already has an explicit workingDirOverride,
			// the explicit value should take precedence over the working directory field.
			const sourceSession: Session = {
				id: 'session-1',
				name: 'SSH Agent',
				toolType: 'claude-code',
				cwd: '/home/devuser/project',
				projectRoot: '/home/devuser/project',
				fullPath: '/home/devuser/project',
				state: 'idle',
				inputMode: 'ai',
				aiPid: 12345,
				terminalPid: 12346,
				port: 3000,
				aiTabs: [],
				activeTabId: 'tab-1',
				closedTabHistory: [],
				shellLogs: [],
				executionQueue: [],
				contextUsage: 0,
				workLog: [],
				isGitRepo: false,
				changedFiles: [],
				fileTree: [],
				fileExplorerExpanded: [],
				fileExplorerScrollPos: 0,
				isLive: false,
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/explicit/override/path',
				},
			} as Session;

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);
			vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
				success: true,
				configs: [
					{
						id: 'remote-1',
						name: 'Dev Server',
						host: 'dev.example.com',
						port: 22,
						username: 'devuser',
						privateKeyPath: '/path/to/key',
						enabled: true,
					},
				],
			});
			vi.mocked(window.maestro.fs.stat).mockResolvedValue({
				size: 4096,
				createdAt: '2024-01-01T00:00:00.000Z',
				modifiedAt: '2024-01-15T12:30:00.000Z',
				isDirectory: true,
				isFile: false,
			});

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
					sourceSession={sourceSession}
				/>
			);

			await waitFor(() => {
				const nameInput = screen.getByLabelText('Agent Name') as HTMLInputElement;
				expect(nameInput.value).toBe('SSH Agent (Copy)');
			});

			// Wait for remote path validation
			await waitFor(
				() => {
					expect(screen.getByText(/Directory found/)).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			// Create the duplicate
			await act(async () => {
				fireEvent.click(screen.getByText('Create Agent'));
			});

			// The explicit workingDirOverride from the source session should be preserved
			expect(onCreate).toHaveBeenCalledWith(
				expect.any(String),
				expect.any(String),
				expect.any(String),
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				expect.objectContaining({
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/explicit/override/path',
				}),
				undefined,
				undefined,
				// The source's token source is unset, so the duplicate falls through to the
				// same default path as a fresh agent: `undefined ?? (isAdaptiveModeDefaultOn() ||
				// undefined)`. On rc Adaptive Mode defaults OFF, so this stays unset rather than
				// pinning a falsy default as an explicit "API" choice. Matches the fresh-agent
				// SSH case above.
				undefined, // enableMaestroP unset: API is the default for Claude Code (Adaptive Mode off)
				undefined, // maestroPPath
				undefined, // maestroPMode unset until the user opts into TUI/Dynamic
				true, // retryOnAvailabilityErrors
				true, // retryOnTokenExhaustion
				undefined, // additionalDirectories
				false, // codexAutoResetOnExhaustion: off by default
				'exec', // codexTransport: Standard by default
				undefined, // gatewayUrl: none unless set on the Models tab
				undefined, // runOn: the provider's own model unless chosen on the Models tab
				NO_PEER_GRANTS, // peerGrants: nothing granted unless set on the Peers tab
				undefined // seedExtras: only a form seeded from a group's defaults has any
			);
		});

		it('should show connection error when SSH remote is unreachable', async () => {
			// Mock detection to return agents with errors when SSH remote is used
			vi.mocked(window.maestro.agents.detect).mockImplementation(async (sshRemoteId?: string) => {
				if (sshRemoteId === 'unreachable-remote') {
					return [
						{
							...createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: false }),
							error: 'Connection refused',
						},
						{
							...createAgentConfig({ id: 'opencode', name: 'OpenCode', available: false }),
							error: 'Connection refused',
						},
					];
				}
				return [
					createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
					createAgentConfig({ id: 'opencode', name: 'OpenCode', available: true }),
				];
			});

			vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
				success: true,
				configs: [
					{
						id: 'unreachable-remote',
						name: 'Unreachable Server',
						host: 'unreachable.example.com',
						port: 22,
						username: 'testuser',
						privateKeyPath: '/path/to/key',
						enabled: true,
					},
				],
			});

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);
			openTab('Provider');

			// Wait for initial load - agents should be detected and shown
			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});

			// Wait for SSH selector
			openTab('SSH');
			await waitFor(() => {
				expect(screen.getByText('SSH Remote Execution')).toBeInTheDocument();
			});

			// Select the unreachable SSH remote using the combobox (select element)
			const dropdown = screen.getByRole('combobox');
			fireEvent.change(dropdown, { target: { value: 'unreachable-remote' } });

			// Wait for connection error to appear
			openTab('Provider');
			await waitFor(() => {
				expect(screen.getByText('Unable to Connect')).toBeInTheDocument();
				expect(screen.getByText('Connection refused')).toBeInTheDocument();
			});

			// Agent list should not be visible
			expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
		});
	});

	describe('Agent Group selector', () => {
		it('hides the Agent Group control when no groups exist', async () => {
			useSessionStore.setState({ groups: [] });

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('Create New Agent')).toBeInTheDocument();
			});
			expect(screen.queryByLabelText('Agent Group')).not.toBeInTheDocument();
		});

		it('renders the dropdown and forwards the picked group through onCreate', async () => {
			useSessionStore.setState({
				groups: [
					{ id: 'group-alpha', name: 'Alpha', emoji: '🅰️', collapsed: false },
					{ id: 'group-beta', name: 'Beta', emoji: '🅱️', collapsed: false },
				],
			});

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			// Dropdown is present and defaults to "No Group (Ungrouped)"
			const trigger = await screen.findByLabelText('Agent Group');
			expect(trigger).toHaveTextContent('No Group (Ungrouped)');

			// Pick "Beta"
			fireEvent.click(trigger);
			fireEvent.click(await screen.findByRole('option', { name: /Beta/ }));

			// Fill required fields and submit
			fireEvent.change(screen.getByLabelText('Agent Name'), {
				target: { value: 'My Agent' },
			});
			fireEvent.change(screen.getByLabelText('Working Directory'), {
				target: { value: '/tmp/work' },
			});

			await waitFor(() => {
				const btn = screen.getByRole('button', { name: 'Create Agent' });
				expect(btn).not.toBeDisabled();
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));
			});

			expect(onCreate).toHaveBeenCalled();
			// 14th positional arg (index 13) is groupId.
			expect(onCreate.mock.calls[0][13]).toBe('group-beta');
		});

		it('seeds the dropdown from presetGroupId so the caller-supplied group is preselected', async () => {
			useSessionStore.setState({
				groups: [{ id: 'group-preset', name: 'Preset', emoji: '📦', collapsed: false }],
			});

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
					presetGroupId="group-preset"
				/>
			);

			const trigger = await screen.findByLabelText('Agent Group');
			await waitFor(() => {
				expect(trigger).toHaveTextContent(/Preset/);
			});
		});
	});

	describe('presetWorkingDir', () => {
		it('seeds the working directory and derives the agent name from its basename', async () => {
			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
					presetWorkingDir="/project/src/renderer"
				/>
			);

			await waitFor(() => {
				expect(screen.getByLabelText('Working Directory')).toHaveValue('/project/src/renderer');
			});
			expect(screen.getByLabelText('Agent Name')).toHaveValue('renderer');
		});

		it('leaves the seeded fields editable', async () => {
			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
					presetWorkingDir="/project/docs"
				/>
			);

			const nameInput = await screen.findByLabelText('Agent Name');
			await waitFor(() => expect(nameInput).toHaveValue('docs'));
			fireEvent.change(nameInput, { target: { value: 'my agent' } });
			expect(nameInput).toHaveValue('my agent');
		});

		it('ignores presetWorkingDir when duplicating so the source cwd wins', async () => {
			const source: Session = {
				id: 'src-1',
				name: 'Source',
				toolType: 'claude-code',
				cwd: '/source/project',
				projectRoot: '/source/project',
				fullPath: '/source/project',
				state: 'idle',
				inputMode: 'ai',
				aiPid: 1,
				terminalPid: 2,
				port: 3000,
				aiTabs: [],
				activeTabId: 'tab-1',
				closedTabHistory: [],
				shellLogs: [],
				executionQueue: [],
				contextUsage: 0,
				workLog: [],
				isGitRepo: false,
				changedFiles: [],
				fileTree: [],
				fileExplorerExpanded: [],
				fileExplorerScrollPos: 0,
				isLive: false,
			} as Session;

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[source]}
					sourceSession={source}
					presetWorkingDir="/project/docs"
				/>
			);

			await waitFor(() => {
				expect(screen.getByLabelText('Working Directory')).toHaveValue('/source/project');
			});
			expect(screen.getByLabelText('Agent Name')).toHaveValue('Source (Copy)');
		});
	});

	describe('Tabbed form', () => {
		const renderModal = (props: Partial<React.ComponentProps<typeof NewInstanceModal>> = {}) =>
			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
					{...props}
				/>
			);

		const selectedTab = () =>
			screen.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true');

		/** Fill the two required General fields and wait until the provider has loaded. */
		const fillRequired = async (name = 'Tabbed Agent', dir = '/my/project') => {
			fireEvent.change(screen.getByLabelText('Agent Name'), { target: { value: name } });
			fireEvent.change(screen.getByPlaceholderText('Select directory...'), {
				target: { value: dir },
			});
			await waitFor(() => expect(screen.getByText('Create Agent')).not.toBeDisabled());
		};

		/** The Models tab's gateway input, once the selected provider is known. */
		const gatewayInput = async () =>
			(await screen.findByTestId('new-agent-gateway')).querySelector('input') as HTMLInputElement;

		it('renders the six tabs in order, opens on General, and is a resizable frame', () => {
			const { container } = renderModal();

			expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
				'General',
				'Provider',
				'Models',
				'Environment',
				'Peers',
				'SSH',
			]);
			expect(selectedTab()).toHaveTextContent('General');
			expect(container.ownerDocument.querySelector('[data-modal-resize-key="new-agent"]')).not.toBe(
				null
			);
		});

		it('renders only the active panel', () => {
			renderModal();

			expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
			expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'new-agent-tabpanel-general');
			expect(screen.queryByText('Agent Provider')).not.toBeInTheDocument();
			openTab('Provider');
			expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'new-agent-tabpanel-provider');
			expect(screen.queryByLabelText('Agent Name')).not.toBeInTheDocument();
		});

		it('opens on General again after a close, with no remembered tab', () => {
			const { rerender } = renderModal();
			openTab('SSH');

			const props = { onClose, onCreate, theme, existingSessions: [] };
			rerender(<NewInstanceModal isOpen={false} {...props} />);
			rerender(<NewInstanceModal isOpen={true} {...props} />);

			expect(selectedTab()).toHaveTextContent('General');
		});

		it('cycles the tabs with Cmd+Shift+] and Cmd+Shift+[', () => {
			renderModal();

			fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
			expect(selectedTab()).toHaveTextContent('Provider');
			fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });
			fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });
			expect(selectedTab()).toHaveTextContent('SSH');
		});

		it('sends Cmd+Enter from SSH to General with the empty name shown as an error', async () => {
			renderModal();
			fireEvent.change(screen.getByPlaceholderText('Select directory...'), {
				target: { value: '/my/project' },
			});
			expect(screen.queryByText('Enter a name for the agent')).not.toBeInTheDocument();
			openTab('SSH');

			fireEvent.keyDown(window, { key: 'Enter', metaKey: true });

			expect(onCreate).not.toHaveBeenCalled();
			expect(selectedTab()).toHaveTextContent('General');
			expect(screen.getByText('Enter a name for the agent')).toBeInTheDocument();
			expect(screen.getByTestId('new-agent-tab-general-error')).toBeInTheDocument();
		});

		it('sends Cmd+Enter to General when the working directory is empty', async () => {
			renderModal();
			fireEvent.change(screen.getByLabelText('Agent Name'), { target: { value: 'No Dir' } });
			openTab('Models');

			fireEvent.keyDown(window, { key: 'Enter', metaKey: true });

			expect(onCreate).not.toHaveBeenCalled();
			expect(selectedTab()).toHaveTextContent('General');
			expect(screen.getByText('Choose a working directory')).toBeInTheDocument();
		});

		it('sends Cmd+Enter to Provider when the provider cannot run', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: false }),
			]);
			renderModal();
			fireEvent.change(screen.getByLabelText('Agent Name'), { target: { value: 'Missing' } });
			fireEvent.change(screen.getByPlaceholderText('Select directory...'), {
				target: { value: '/my/project' },
			});
			openTab('SSH');

			fireEvent.keyDown(window, { key: 'Enter', metaKey: true });

			expect(onCreate).not.toHaveBeenCalled();
			expect(selectedTab()).toHaveTextContent('Provider');
		});

		it('saves the gateway set on the Models tab onto the created agent', async () => {
			renderModal();
			await fillRequired();
			openTab('Models');

			fireEvent.change(await gatewayInput(), { target: { value: 'http://127.0.0.1:8787/' } });
			await act(async () => {
				fireEvent.click(screen.getByText('Create Agent'));
			});

			expect(onCreate).toHaveBeenCalledTimes(1);
			// gatewayUrl is the 23rd argument, stored in its normalized form.
			expect(onCreate.mock.calls[0][22]).toBe('http://127.0.0.1:8787');
		});

		it('refuses a gateway that is not a URL, on the Models tab, without creating', async () => {
			renderModal();
			await fillRequired();
			openTab('Models');
			fireEvent.change(await gatewayInput(), { target: { value: 'not a url' } });
			openTab('General');

			await act(async () => {
				fireEvent.click(screen.getByText('Create Agent'));
			});

			expect(onCreate).not.toHaveBeenCalled();
			expect(selectedTab()).toHaveTextContent('Models');
			expect(screen.getByTestId('new-agent-tab-models-error')).toBeInTheDocument();
			expect(screen.getByTestId('new-agent-gateway-url-status')).toHaveTextContent('not a URL');

			// Editing the field clears the refusal and its dot.
			fireEvent.change(await gatewayInput(), { target: { value: '' } });
			expect(screen.queryByTestId('new-agent-tab-models-error')).not.toBeInTheDocument();
		});

		describe('Peers tab', () => {
			afterEach(() => {
				useSessionStore.setState({ sessions: [], groups: [] });
			});

			it('draws the Peer Agents section for the chosen group and creates the agent with the three grants', async () => {
				// The fleet and the group name come from the store, not from the
				// `existingSessions` prop.
				useSessionStore.setState({
					sessions: [
						createMockSession({ id: 'peer-infra', name: 'Infra', groupId: 'group-backend' }),
						createMockSession({ id: 'peer-docs', name: 'Docs' }),
					],
					groups: [{ id: 'group-backend', name: 'Backend', emoji: '🛠', collapsed: false }],
				});
				renderModal();
				await fillRequired();

				// No group chosen yet, so the group grant cannot be used.
				openTab('Peers');
				expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'new-agent-tabpanel-peers');
				expect(screen.getByText('Peer Agents')).toBeInTheDocument();
				expect(screen.getByRole('checkbox', { name: /Peers in my group/ })).toBeDisabled();

				// Choosing a group on General enables it, and the count follows.
				openTab('General');
				fireEvent.click(screen.getByLabelText('Agent Group'));
				fireEvent.click(await screen.findByRole('option', { name: /Backend/ }));
				openTab('Peers');
				const groupGrant = screen.getByRole('checkbox', { name: /Peers in my group/ });
				expect(groupGrant).toBeEnabled();
				expect(screen.getByText('1 other agent in Backend')).toBeInTheDocument();
				fireEvent.click(groupGrant);

				// The new agent has no id yet, so the picker offers the whole fleet.
				fireEvent.click(screen.getByRole('button', { name: 'Add Peer' }));
				fireEvent.click(screen.getByRole('button', { name: 'Peer agent' }));
				expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
					'Select an agent...',
					'Docs',
					'Infra',
				]);
				fireEvent.click(screen.getByRole('option', { name: 'Docs' }));
				fireEvent.click(screen.getByRole('switch', { name: 'Delegate to this peer' }));

				await act(async () => {
					fireEvent.click(screen.getByText('Create Agent'));
				});

				expect(onCreate).toHaveBeenCalledTimes(1);
				// peerGrants is the 25th argument. The empty note is not stored.
				const grants = onCreate.mock.calls[0][24];
				expect(grants).toEqual({
					peerAgents: [{ sessionId: 'peer-docs', read: true, write: true }],
					groupPeerAccess: { read: true, write: false },
					worktreePeerAccess: undefined,
				});
				// Off is absent, never a pair of false bits.
				expect(grants.worktreePeerAccess).toBeUndefined();
			});
		});

		describe('Run on', () => {
			const OLLAMA = {
				id: 'ep-ollama',
				name: 'Ollama',
				kind: 'ollama' as const,
				baseUrl: 'http://127.0.0.1:11434',
				enabled: true,
			};
			const QWEN = {
				type: 'source' as const,
				endpointId: OLLAMA.id,
				model: 'qwen3:latest',
				contextTokens: 40_960,
			};
			// runOn is the 24th argument of onCreate.
			const RUN_ON_ARG = 23;
			let savedEndpoints: ReturnType<typeof useSettingsStore.getState>['localModelEndpoints'];

			beforeEach(() => {
				savedEndpoints = useSettingsStore.getState().localModelEndpoints;
				useSettingsStore.setState({ localModelEndpoints: [OLLAMA] });
				vi.mocked(window.maestro.localModels.endpoints.listModels).mockImplementation(
					async (endpoint) =>
						typeof endpoint === 'string'
							? { ok: true, models: [] }
							: { ok: true, models: [{ id: 'qwen3:latest' }] }
				);
			});

			afterEach(() => {
				useSettingsStore.setState({ localModelEndpoints: savedEndpoints });
				vi.mocked(window.maestro.localModels.endpoints.listModels).mockResolvedValue({
					ok: true,
					models: [],
				});
			});

			const picker = async () =>
				(await screen.findByTestId('new-agent-run-on-field-select')) as HTMLSelectElement;
			const pickQwen = async () => {
				const select = await picker();
				await waitFor(() =>
					expect(
						Array.from(select.options).some((option) => option.value === 'ep-ollama:qwen3:latest')
					).toBe(true)
				);
				fireEvent.change(select, { target: { value: 'ep-ollama:qwen3:latest' } });
			};

			it('saves the model picked on the Models tab onto the created agent', async () => {
				renderModal();
				await fillRequired();
				openTab('Models');

				await pickQwen();
				await act(async () => {
					fireEvent.click(screen.getByText('Create Agent'));
				});

				expect(onCreate).toHaveBeenCalledTimes(1);
				expect(onCreate.mock.calls[0][RUN_ON_ARG]).toEqual(QWEN);
			});

			it('disables the gateway field while a source is chosen', async () => {
				renderModal();
				await fillRequired();
				openTab('Models');

				expect(await gatewayInput()).not.toBeDisabled();
				await pickQwen();

				expect(await gatewayInput()).toBeDisabled();
				expect(screen.getByTestId('new-agent-gateway-url-status')).toHaveTextContent(
					'Not applied while Run on is a source'
				);
			});

			it('tests the target from the form alone, since no agent exists yet', async () => {
				renderModal();
				await fillRequired();
				openTab('Models');
				await pickQwen();

				fireEvent.click(screen.getByTestId('new-agent-run-on-field-test'));

				await waitFor(() =>
					expect(window.maestro.localModels.runOn.test).toHaveBeenCalledWith({
						target: QWEN,
						subject: expect.objectContaining({
							toolType: 'claude-code',
							cwd: '/my/project',
							sshRemoteConfig: { enabled: false, remoteId: null },
						}),
					})
				);
				expect(onCreate).not.toHaveBeenCalled();
			});

			it('carries the target of the agent being duplicated', async () => {
				renderModal({
					sourceSession: createMockSession({
						id: 'source-1',
						name: 'Source',
						toolType: 'claude-code',
						cwd: '/source/project',
						runOn: { ...QWEN, contextTokens: 65_536 },
					}),
				});
				openTab('Models');

				await waitFor(async () => expect((await picker()).value).toBe('ep-ollama:qwen3:latest'));
			});
		});

		it('carries the gateway of the agent being duplicated', async () => {
			renderModal({
				sourceSession: createMockSession({
					id: 'source-1',
					name: 'Source',
					toolType: 'claude-code',
					cwd: '/source/project',
					gatewayUrl: 'http://127.0.0.1:9000',
				}),
			});
			openTab('Models');

			await waitFor(async () => expect((await gatewayInput()).value).toBe('http://127.0.0.1:9000'));
		});

		it('edits env vars on the Environment tab only, for the selected provider', async () => {
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
				customEnvVars: { API_KEY: 'test-key' },
			});
			renderModal();
			await fillRequired();

			openTab('Provider');
			fireEvent.click(screen.getByText('Claude Code'));
			await waitFor(() =>
				expect(screen.getByPlaceholderText('/path/to/claude')).toBeInTheDocument()
			);
			expect(screen.queryByDisplayValue('API_KEY')).not.toBeInTheDocument();

			openTab('Environment');
			expect(screen.getByText(/Editing the Claude Code environment\./)).toBeInTheDocument();
			fireEvent.change(screen.getByDisplayValue('test-key'), { target: { value: 'new-key' } });
			openTab('General');
			await act(async () => {
				fireEvent.click(screen.getByText('Create Agent'));
			});

			expect(onCreate.mock.calls[0][7]).toEqual({ API_KEY: 'new-key' });
		});

		it('shows the Runs on chip on General and Agent Resilience on Provider', async () => {
			renderModal();
			expect(screen.getByTestId('new-agent-runs-on')).toHaveTextContent('Local');
			expect(screen.queryByText('Agent Resilience')).not.toBeInTheDocument();

			openTab('Provider');
			await waitFor(() => expect(screen.getByText('Agent Resilience')).toBeInTheDocument());
		});
	});

	// A group's defaults are copy-at-create: they fill the form once, as it opens
	// for an agent created in that group.
	describe('Group defaults seed', () => {
		// Not 🌳: that emoji marks a worktree group, which has no Group Settings.
		const GROUP_ID = 'group-backend';
		const withGroupDefaults = (defaults: Record<string, unknown> | undefined) =>
			useSessionStore.setState({
				groups: [
					{
						id: GROUP_ID,
						name: 'Backend',
						emoji: '📦',
						collapsed: false,
						...(defaults ? { defaults } : {}),
					},
				] as never,
			});

		const REMOTE = {
			id: 'remote-1',
			name: 'Test Server',
			host: 'test.example.com',
			port: 22,
			username: 'testuser',
			privateKeyPath: '/path/to/key',
			enabled: true,
		};

		const renderSeeded = (props: Partial<React.ComponentProps<typeof NewInstanceModal>> = {}) =>
			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
					presetGroupId={GROUP_ID}
					{...props}
				/>
			);

		const banner = () => screen.findByTestId('new-agent-group-seed-banner');

		/** Name the agent, give it a directory unless the seed did, and create it. */
		const create = async (dir: string | null = '/my/project') => {
			fireEvent.change(screen.getByLabelText('Agent Name'), { target: { value: 'Seeded' } });
			if (dir !== null) {
				fireEvent.change(screen.getByLabelText('Working Directory'), { target: { value: dir } });
			}
			await waitFor(() => expect(screen.getByText('Create Agent')).not.toBeDisabled());
			await act(async () => {
				fireEvent.click(screen.getByText('Create Agent'));
			});
			expect(onCreate).toHaveBeenCalledTimes(1);
			return onCreate.mock.calls[0];
		};

		beforeEach(() => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
				createAgentConfig({ id: 'codex', name: 'Codex', available: true, binaryName: 'codex' }),
			]);
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});
		});

		afterEach(() => {
			useModalStore.getState().closeModal('groupSettings');
		});

		it('pre-fills the provider, the nudge and the env vars, and says where they came from', async () => {
			withGroupDefaults({
				toolType: 'codex',
				nudgeMessage: 'Be brief.',
				customEnvVars: { CODEX_HOME: '~/.work' },
			});
			renderSeeded();

			expect(await banner()).toHaveTextContent(
				'Pre-filled from 📦 Backend group settings. Edit anything before creating.'
			);
			expect(await screen.findByDisplayValue('Be brief.')).toBeInTheDocument();

			// The seed's provider is selected, not the first one this machine can run.
			openTab('Environment');
			expect(await screen.findByText(/Editing the Codex environment\./)).toBeInTheDocument();
			expect(screen.getByDisplayValue('CODEX_HOME')).toBeInTheDocument();
			expect(screen.getByDisplayValue('~/.work')).toBeInTheDocument();

			openTab('General');
			const args = await create();
			expect(args[0]).toBe('codex');
			expect(args[3]).toBe('Be brief.');
			expect(args[7]).toEqual({ CODEX_HOME: '~/.work' });
			expect(args[13]).toBe(GROUP_ID);
			// Nothing the form has no control for.
			expect(args[25]).toBeUndefined();
		});

		it('fills env vars for a default that names no provider, over the provider own', async () => {
			// The motivating case: one variable pinned for every agent in the group.
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
				customEnvVars: { API_KEY: 'provider-level' },
			});
			withGroupDefaults({ customEnvVars: { CLAUDE_CONFIG_DIR: '~/.work' } });
			renderSeeded();
			await banner();

			openTab('Environment');
			expect(await screen.findByDisplayValue('CLAUDE_CONFIG_DIR')).toBeInTheDocument();
			// The group has no opinion on a variable it does not name.
			expect(screen.getByDisplayValue('API_KEY')).toBeInTheDocument();

			openTab('General');
			const args = await create();
			// No default provider: the first one this machine can run.
			expect(args[0]).toBe('claude-code');
			expect(args[7]).toEqual({ API_KEY: 'provider-level', CLAUDE_CONFIG_DIR: '~/.work' });
		});

		it('keeps the provider own path and args when the default has none', async () => {
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({ customArgs: '--verbose' });
			withGroupDefaults({ toolType: 'claude-code', nudgeMessage: 'Be brief.' });
			renderSeeded();
			await banner();

			const args = await create();
			expect(args[6]).toBe('--verbose');
		});

		it('carries a resilience flag the group switched off onto whichever provider is picked', async () => {
			withGroupDefaults({ retryOnTokenExhaustion: false });
			renderSeeded();
			await banner();

			const args = await create();
			expect(args[17]).toBe(true); // retryOnAvailabilityErrors: no opinion, so on
			expect(args[18]).toBe(false); // retryOnTokenExhaustion
		});

		it('shows no banner for a group with no defaults', async () => {
			withGroupDefaults(undefined);
			renderSeeded();

			const trigger = await screen.findByLabelText('Agent Group');
			await waitFor(() => expect(trigger).toHaveTextContent(/Backend/));
			await waitFor(() => expect(screen.getByLabelText('Agent Name')).toBeInTheDocument());
			expect(screen.queryByTestId('new-agent-group-seed-banner')).not.toBeInTheDocument();
		});

		it('shows no banner with no preset group', async () => {
			withGroupDefaults({ nudgeMessage: 'Be brief.' });
			renderSeeded({ presetGroupId: null });

			await screen.findByLabelText('Agent Group');
			expect(screen.queryByTestId('new-agent-group-seed-banner')).not.toBeInTheDocument();
			expect(screen.queryByDisplayValue('Be brief.')).not.toBeInTheDocument();
		});

		it('never seeds a duplicate: it is its source copy', async () => {
			withGroupDefaults({ nudgeMessage: 'From the group.' });
			renderSeeded({
				sourceSession: createMockSession({
					id: 'source-1',
					name: 'Source',
					toolType: 'claude-code',
					cwd: '/source/project',
					groupId: GROUP_ID,
					nudgeMessage: 'From the source.',
				}),
			});

			expect(await screen.findByDisplayValue('From the source.')).toBeInTheDocument();
			expect(screen.queryByTestId('new-agent-group-seed-banner')).not.toBeInTheDocument();
		});

		it('does not reseed when another group is picked afterwards', async () => {
			useSessionStore.setState({
				groups: [
					{
						id: GROUP_ID,
						name: 'Backend',
						emoji: '📦',
						collapsed: false,
						defaults: { nudgeMessage: 'From Backend.' },
					},
					{
						id: 'group-docs',
						name: 'Docs',
						emoji: '📚',
						collapsed: false,
						defaults: { nudgeMessage: 'From Docs.' },
					},
				] as never,
			});
			renderSeeded();
			expect(await screen.findByDisplayValue('From Backend.')).toBeInTheDocument();

			fireEvent.click(screen.getByLabelText('Agent Group'));
			fireEvent.click(await screen.findByRole('option', { name: /Docs/ }));

			// The agent moves. What the form holds does not change.
			expect(screen.getByDisplayValue('From Backend.')).toBeInTheDocument();
			expect(screen.queryByDisplayValue('From Docs.')).not.toBeInTheDocument();
			expect(await banner()).toHaveTextContent('📦 Backend');
			const args = await create();
			expect(args[13]).toBe('group-docs');
			expect(args[3]).toBe('From Backend.');
		});

		it('a working directory the caller named outranks the group default one', async () => {
			withGroupDefaults({ projectRoot: '/srv/group-default', nudgeMessage: 'Be brief.' });
			renderSeeded({ presetWorkingDir: '/project/here' });
			await banner();
			await screen.findByDisplayValue('Be brief.');

			expect(screen.getByLabelText('Working Directory')).toHaveValue('/project/here');
		});

		it('seeds the working directory from the group default', async () => {
			withGroupDefaults({ projectRoot: '/srv/group-default' });
			renderSeeded();

			await waitFor(() =>
				expect(screen.getByLabelText('Working Directory')).toHaveValue('/srv/group-default')
			);
		});

		it('the group name closes the form and opens Group Settings for that group', async () => {
			withGroupDefaults({ nudgeMessage: 'Be brief.' });
			renderSeeded();

			fireEvent.click(within(await banner()).getByRole('button', { name: /Backend/ }));

			expect(onClose).toHaveBeenCalledTimes(1);
			expect(onCreate).not.toHaveBeenCalled();
			expect(useModalStore.getState().isOpen('groupSettings')).toBe(true);
			expect(useModalStore.getState().getData('groupSettings')).toEqual({ groupId: GROUP_ID });
		});

		describe('SSH remote', () => {
			beforeEach(() => {
				// Remote path validation is informational; give it a directory.
				vi.mocked(window.maestro.fs.stat).mockResolvedValue({
					size: 4096,
					createdAt: '2024-01-01T00:00:00.000Z',
					modifiedAt: '2024-01-15T12:30:00.000Z',
					isDirectory: true,
					isFile: false,
				});
			});

			it('seeds SSH off with a note when the remote no longer exists', async () => {
				vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
					success: true,
					configs: [],
				});
				withGroupDefaults({
					nudgeMessage: 'Be brief.',
					sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-gone' },
				});
				renderSeeded();

				expect(await banner()).toHaveTextContent('SSH remote no longer exists, running locally.');
				expect(screen.getByTestId('new-agent-runs-on')).toHaveTextContent('Local');

				const args = await create();
				// Never handed a remote id that resolves to nothing.
				expect(args[11]).toMatchObject({ enabled: false, remoteId: null });
				expect(window.maestro.agents.detect).not.toHaveBeenCalledWith('remote-gone');
			});

			it('seeds the remote, and keeps the seed through the detection the remote causes', async () => {
				vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
					success: true,
					configs: [REMOTE],
				});
				withGroupDefaults({
					toolType: 'claude-code',
					projectRoot: '~/git/app',
					customEnvVars: { CLAUDE_CONFIG_DIR: '~/.work' },
					sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				});
				renderSeeded();

				const seeded = await banner();
				expect(seeded).not.toHaveTextContent('SSH remote no longer exists');
				// Turning the remote on makes the form detect providers on it.
				await waitFor(() => expect(window.maestro.agents.detect).toHaveBeenCalledWith('remote-1'));
				await waitFor(() =>
					expect(screen.getByLabelText('Working Directory')).toHaveValue('~/git/app')
				);

				// That pass must not replace what the seed filled.
				openTab('Environment');
				expect(await screen.findByDisplayValue('CLAUDE_CONFIG_DIR')).toBeInTheDocument();

				openTab('General');
				const args = await create(null);
				// A remote path keeps its `~`: only the remote shell can expand it.
				expect(args[1]).toBe('~/git/app');
				expect(args[7]).toEqual({ CLAUDE_CONFIG_DIR: '~/.work' });
				expect(args[11]).toMatchObject({
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '~/git/app',
				});
			});
		});

		describe('defaults the form has no control for', () => {
			const TIERS = { low: { type: 'provider-model', model: 'haiku' } };

			it('names them in the banner and hands them to onCreate', async () => {
				withGroupDefaults({
					toolType: 'claude-code',
					tierTargets: TIERS,
					systemOneOptOut: true,
					customEnvVarsDisabled: { DEBUG: '1' },
				});
				renderSeeded();

				const extras = await screen.findByTestId('new-agent-group-seed-extras');
				expect(extras).toHaveTextContent(
					'Also set when the agent is created: Tier Targets, System One, Environment Variables (switched off).'
				);

				const args = await create();
				expect(args[25]).toEqual({
					tierTargets: TIERS,
					systemOneOptOut: true,
					customEnvVarsDisabled: { DEBUG: '1' },
				});
			});

			it('drops the provider-bound ones when another provider is picked', async () => {
				withGroupDefaults({
					toolType: 'claude-code',
					tierTargets: TIERS,
					systemOneOptOut: true,
				});
				renderSeeded();
				await screen.findByTestId('new-agent-group-seed-extras');

				openTab('Provider');
				fireEvent.click(await screen.findByRole('option', { name: /Codex/i }));

				// Judged against the form as it stands, not as it was seeded.
				await waitFor(() =>
					expect(screen.getByTestId('new-agent-group-seed-extras')).toHaveTextContent(
						'Also set when the agent is created: System One.'
					)
				);
				openTab('General');
				const args = await create();
				expect(args[0]).toBe('codex');
				expect(args[25]).toEqual({ systemOneOptOut: true });
			});

			it('says which default was left out, and why', async () => {
				withGroupDefaults({ toolType: 'claude-code', tokenProxyMode: 'compress' });
				renderSeeded();
				expect(await screen.findByTestId('new-agent-group-seed-extras')).toHaveTextContent(
					'Maestro Token Proxy'
				);

				// A gateway typed in the form: the proxy would take its place.
				openTab('Models');
				const gateway = (await screen.findByTestId('new-agent-gateway')).querySelector(
					'input'
				) as HTMLInputElement;
				fireEvent.change(gateway, { target: { value: 'http://127.0.0.1:8787' } });

				await waitFor(() =>
					expect(screen.getByTestId('new-agent-group-seed-skipped')).toHaveTextContent(
						'Not pre-filled: Maestro Token Proxy.'
					)
				);
				expect(screen.queryByTestId('new-agent-group-seed-extras')).not.toBeInTheDocument();
			});
		});
	});
});
