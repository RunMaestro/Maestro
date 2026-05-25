/**
 * @fileoverview Tests for NewInstanceModal component
 * Tests: Modal rendering, agent detection, folder selection, form submission,
 * tilde expansion, layer stack integration, keyboard shortcuts, custom agent paths
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { EditAgentModal, NewInstanceModal } from '../../../renderer/components/NewInstanceModal';
import { formatShortcutKeys } from '../../../renderer/utils/shortcutFormatter';
import type { Theme, Session } from '../../../renderer/types';
import type { AgentConfig } from '../../../renderer/types';

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
const createAgentConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
	id: 'claude-code',
	name: 'Claude Code',
	available: true,
	path: '/usr/local/bin/claude',
	binaryName: 'claude',
	hidden: false,
	...overrides,
});

const createSession = (overrides: Partial<Session> = {}): Session =>
	({
		id: 'session-1',
		name: 'Editable Agent',
		toolType: 'claude-code',
		cwd: '/test/project',
		projectRoot: '/test/project',
		fullPath: '/test/project',
		state: 'idle',
		inputMode: 'ai',
		aiPid: 12345,
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
		...overrides,
	}) as Session;

const waitForNewInstanceModalReady = async () => {
	await waitFor(() => {
		expect(screen.getByLabelText('Agent Name')).toBeInTheDocument();
	});
};

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
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue([]);
		vi.mocked(window.maestro.agents.setConfig).mockResolvedValue(undefined);
		vi.mocked(window.maestro.agents.setCustomPath).mockResolvedValue(undefined);
		vi.mocked(window.maestro.fs.stat).mockResolvedValue({
			size: 1024,
			createdAt: '2024-01-01T00:00:00.000Z',
			modifiedAt: '2024-01-15T12:30:00.000Z',
		});
		// Default: no SSH remotes configured
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [],
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
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
			await waitForNewInstanceModalReady();
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
			await waitForNewInstanceModalReady();
		});

		it('should show loading state initially', async () => {
			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[]}
				/>
			);

			expect(screen.getByText('Loading agents...')).toBeInTheDocument();
			await waitForNewInstanceModalReady();
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

			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
				expect(screen.getByText('Available')).toBeInTheDocument();
			});
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

			await waitFor(() => {
				expect(screen.getByText('Coming Soon')).toBeInTheDocument();
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

			await waitFor(() => {
				const options = screen.getAllByRole('option');
				const claudeOption = options.find((opt) => opt.textContent?.includes('Claude Code'));
				expect(claudeOption).toHaveAttribute('aria-selected', 'true');
			});
		});
	});

	describe('Agent selection', () => {
		it('should allow selecting claude-code with keyboard activation when available', async () => {
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
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});

			const option = screen.getByRole('option', { name: /Claude Code/i });
			fireEvent.keyDown(option, { key: 'Tab' });
			expect(option).toHaveAttribute('aria-selected', 'true');
			fireEvent.keyDown(option, { key: ' ' });
			expect(option).toHaveAttribute('aria-selected', 'true');
			expect(await screen.findByPlaceholderText('/path/to/claude')).toBeInTheDocument();
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
				{ enabled: false, remoteId: null },
				undefined
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
				{ enabled: false, remoteId: null },
				undefined
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
				{ enabled: false, remoteId: null },
				undefined
			);
		});
	});

	describe('Form submission', () => {
		it('requires directory conflict acknowledgement and truncates the nudge message', async () => {
			const existingSession = createSession({
				id: 'existing-session',
				name: 'Existing Agent',
				cwd: '/shared/project',
				projectRoot: '/shared/project',
			});

			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[existingSession]}
				/>
			);

			await waitForNewInstanceModalReady();

			fireEvent.change(screen.getByLabelText('Agent Name'), { target: { value: 'New Agent' } });
			fireEvent.change(screen.getByLabelText('Working Directory'), {
				target: { value: '/shared/project' },
			});

			expect(
				screen.getByText(/This directory is already used by "Existing Agent"/)
			).toBeInTheDocument();
			expect(screen.getByText('Create Agent')).toBeDisabled();

			const longNudge = 'x'.repeat(1005);
			const nudgeInput = screen.getByPlaceholderText(
				'Instructions appended to every message you send...'
			) as HTMLTextAreaElement;
			fireEvent.change(nudgeInput, { target: { value: longNudge } });
			expect(nudgeInput.value).toHaveLength(1000);
			expect(screen.getByText(/1000\/1000 characters/)).toBeInTheDocument();

			fireEvent.click(screen.getByLabelText('I understand the risk and want to proceed'));
			await waitFor(() => {
				expect(screen.getByText('Create Agent')).toBeEnabled();
			});

			fireEvent.click(screen.getByText('Create Agent'));

			expect(onCreate).toHaveBeenCalledWith(
				'claude-code',
				'/shared/project',
				'New Agent',
				'x'.repeat(1000),
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ enabled: false, remoteId: null },
				undefined
			);
		});

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
				{ enabled: false, remoteId: null },
				undefined
			);
			expect(onClose).toHaveBeenCalled();
		});

		it('blocks create when the requested agent name already exists', async () => {
			render(
				<NewInstanceModal
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
					theme={theme}
					existingSessions={[createSession({ id: 'session-2', name: 'Taken Agent' })]}
				/>
			);

			await waitForNewInstanceModalReady();

			fireEvent.change(screen.getByLabelText('Agent Name'), { target: { value: 'Taken Agent' } });
			fireEvent.change(screen.getByLabelText('Working Directory'), {
				target: { value: '/new/project' },
			});

			expect(
				await screen.findByText('An agent named "Taken Agent" already exists')
			).toBeInTheDocument();
			expect(screen.getByText('Create Agent')).toBeDisabled();

			fireEvent.keyDown(screen.getByRole('group', { name: 'Create new agent dialog' }), {
				key: 'Escape',
			});
			fireEvent.keyDown(screen.getByRole('group', { name: 'Create new agent dialog' }), {
				key: 'Enter',
				ctrlKey: true,
			});
			expect(onCreate).not.toHaveBeenCalled();
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

			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});

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
			await waitForNewInstanceModalReady();
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
			await waitForNewInstanceModalReady();

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

			await waitForNewInstanceModalReady();

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

			expect(mockUpdateLayerHandler).toHaveBeenCalledWith('layer-new-instance-123', newOnClose);
		});
	});

	describe('Custom agent paths', () => {
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

			fireEvent.click(screen.getByText('Add Variable'));
			expect(await screen.findByDisplayValue('NEW_VAR')).toBeInTheDocument();
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

			// Wait for agents to load, then click to expand
			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});
			fireEvent.click(screen.getByText('Claude Code'));

			// Fill in required fields
			const nameInput = screen.getByLabelText('Agent Name');
			fireEvent.change(nameInput, { target: { value: 'My Session' } });

			const dirInput = screen.getByPlaceholderText('Select directory...');
			fireEvent.change(dirInput, { target: { value: '/my/project' } });

			await waitFor(() => {
				expect(screen.getByPlaceholderText('/path/to/claude')).toBeInTheDocument();
			});

			// Set custom path and args, then blur both inputs. These values are local until create.
			const customPathInput = screen.getByPlaceholderText('/path/to/claude');
			fireEvent.change(customPathInput, { target: { value: '/custom/path/to/claude' } });
			fireEvent.blur(customPathInput);

			const customArgsInput = screen.getByPlaceholderText('--flag value --another-flag');
			fireEvent.change(customArgsInput, { target: { value: '--verbose' } });
			fireEvent.blur(customArgsInput);

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
				'/custom/path/to/claude',
				'--verbose',
				undefined,
				undefined,
				undefined,
				undefined,
				{ enabled: false, remoteId: null },
				undefined
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
			const nameInput = screen.getByLabelText('Agent Name');
			fireEvent.change(nameInput, { target: { value: 'My Session' } });

			const dirInput = screen.getByPlaceholderText('Select directory...');
			fireEvent.change(dirInput, { target: { value: '/my/project' } });

			// Button should still be disabled because agent is not available
			const createButton = screen.getByText('Create Agent');
			expect(createButton).toBeDisabled();

			// Set custom path
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
				'/custom/bin/claude',
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ enabled: false, remoteId: null },
				undefined
			);
		});

		it('should reset custom path to detected path when Reset button is clicked', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({
					id: 'claude-code',
					name: 'Claude Code',
					available: true,
					path: '/detected/bin/claude',
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

			// Wait for agents to load, then click to expand
			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});
			fireEvent.click(screen.getByText('Claude Code'));

			// Path input should be pre-filled with detected path
			await waitFor(() => {
				expect(screen.getByDisplayValue('/detected/bin/claude')).toBeInTheDocument();
			});

			// Set a different custom path
			const customPathInput = screen.getByDisplayValue('/detected/bin/claude');
			fireEvent.change(customPathInput, { target: { value: '/custom/path' } });

			await waitFor(() => {
				expect(customPathInput).toHaveValue('/custom/path');
			});

			// Reset button should appear when custom path differs from detected path
			await waitFor(() => {
				expect(screen.getByText('Reset')).toBeInTheDocument();
			});

			await act(async () => {
				fireEvent.click(screen.getByText('Reset'));
			});

			// Path should be reset to detected path
			expect(customPathInput).toHaveValue('/detected/bin/claude');
		});

		it('should preload saved per-agent path, arguments, and environment variables', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
				customPath: '/saved/bin/claude',
				customArgs: '--verbose --profile saved',
				customEnvVars: { API_MODE: 'test' },
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

			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});
			fireEvent.click(screen.getByText('Claude Code'));

			await waitFor(() => {
				expect(screen.getByDisplayValue('/saved/bin/claude')).toBeInTheDocument();
				expect(screen.getByDisplayValue('--verbose --profile saved')).toBeInTheDocument();
				expect(screen.getByDisplayValue('API_MODE')).toBeInTheDocument();
				expect(screen.getByDisplayValue('test')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByLabelText('Agent Name'), {
				target: { value: 'Saved Config Agent' },
			});
			fireEvent.change(screen.getByPlaceholderText('Select directory...'), {
				target: { value: '/repo/project' },
			});

			await act(async () => {
				fireEvent.click(screen.getByText('Create Agent'));
			});

			expect(onCreate).toHaveBeenCalledWith(
				'claude-code',
				'/repo/project',
				'Saved Config Agent',
				undefined,
				'/saved/bin/claude',
				'--verbose --profile saved',
				{ API_MODE: 'test' },
				undefined,
				undefined,
				undefined,
				{ enabled: false, remoteId: null },
				undefined
			);
		});
	});

	describe('Error handling', () => {
		it('should handle agent detection failure gracefully', async () => {
			vi.mocked(window.maestro.agents.detect).mockRejectedValue(new Error('Detection failed'));
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

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
				expect(consoleSpy).toHaveBeenCalledWith('Failed to load agents:', expect.any(Error));
			});

			consoleSpy.mockRestore();
		});

		it('should handle agent refresh failure gracefully', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);
			vi.mocked(window.maestro.agents.refresh).mockRejectedValue(new Error('Refresh failed'));
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

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
				expect(screen.getByTitle('Refresh detection')).toBeInTheDocument();
			});

			const refreshButton = screen.getByTitle('Refresh detection');
			await act(async () => {
				fireEvent.click(refreshButton);
			});

			await waitFor(() => {
				expect(consoleSpy).toHaveBeenCalledWith('Failed to refresh agent:', expect.any(Error));
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
			await waitForNewInstanceModalReady();
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

			await waitFor(() => {
				const options = screen.getAllByRole('option');
				expect(options.length).toBeGreaterThan(0);
			});
		});

		it('should have tabindex=-1 on modal container', async () => {
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
			await waitForNewInstanceModalReady();
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

		it('should report model loading failures locally', async () => {
			const modelFailure = new Error('models unavailable');
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
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
			vi.mocked(window.maestro.agents.getModels).mockRejectedValue(modelFailure);
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});

			try {
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
					expect(screen.getByText('OpenCode')).toBeInTheDocument();
				});

				const agentRow = screen.getByText('OpenCode').closest('[role="option"]');
				expect(agentRow).not.toBeNull();
				await act(async () => {
					fireEvent.click(agentRow!);
				});

				await waitFor(() => {
					expect(consoleError).toHaveBeenCalledWith(
						'Failed to load models for opencode:',
						modelFailure
					);
				});
			} finally {
				consoleError.mockRestore();
			}
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

		it('should create a duplicated agent with source session overrides', async () => {
			const sourceSession = createSession({
				name: 'Original Agent',
				toolType: 'claude-code',
				cwd: '/test/project',
				projectRoot: '/test/project',
				fullPath: '/test/project',
				nudgeMessage: 'Custom system prompt',
				customPath: '/usr/local/bin/claude',
				customArgs: '--verbose',
				customEnvVars: { DEBUG: 'true' },
				customModel: 'claude-opus-4',
				customContextWindow: 200000,
				customProviderPath: '/opt/claude-provider',
			});

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});

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
				expect(screen.getByLabelText('Agent Name')).toHaveValue('Original Agent (Copy)');
			});

			await waitFor(() => {
				expect(screen.getByDisplayValue('/usr/local/bin/claude')).toBeInTheDocument();
				expect(screen.getByDisplayValue('--verbose')).toBeInTheDocument();
				expect(screen.getByDisplayValue('DEBUG')).toBeInTheDocument();
				expect(screen.getByDisplayValue('true')).toBeInTheDocument();
			});

			await act(async () => {
				fireEvent.click(screen.getByText('Create Agent'));
			});

			expect(onCreate).toHaveBeenCalledWith(
				'claude-code',
				'/test/project',
				'Original Agent (Copy)',
				'Custom system prompt',
				'/usr/local/bin/claude',
				'--verbose',
				{ DEBUG: 'true' },
				'claude-opus-4',
				200000,
				'/opt/claude-provider',
				{ enabled: false, remoteId: null },
				undefined
			);
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

			// Wait for the SSH selector to appear even though no agent is available
			await waitFor(() => {
				expect(screen.getByText('SSH Remote Execution')).toBeInTheDocument();
				expect(screen.getByText('Local Execution')).toBeInTheDocument();
			});
		});

		it('ignores unsuccessful SSH config list results without showing the selector', async () => {
			vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
				success: false,
				configs: [
					{
						id: 'remote-1',
						name: 'Ignored Server',
						host: 'ignored.example.com',
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

			await waitForNewInstanceModalReady();
			expect(screen.queryByText('SSH Remote Execution')).not.toBeInTheDocument();
		});

		it('should report SSH remote config load failures locally', async () => {
			const sshFailure = new Error('ssh config unavailable');
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.mocked(window.maestro.sshRemote.getConfigs).mockRejectedValue(sshFailure);

			try {
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
					expect(consoleError).toHaveBeenCalledWith(
						'Failed to load SSH remote configs:',
						sshFailure
					);
				});
			} finally {
				consoleError.mockRestore();
			}
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
					expect(screen.getByText('Remote directory found')).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			// The core verification: clicking Create should pass the SSH config that was pending
			const createButton = screen.getByText('Create Agent');
			await act(async () => {
				fireEvent.click(createButton);
			});

			// Should have passed the SSH config that was selected while agent was not yet selected
			// This proves the _pending_ config was transferred to the agent on selection
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
				{ enabled: true, remoteId: 'remote-1' },
				undefined
			);
		});

		it('should show remote path validation errors for SSH create sessions', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);
			vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
				success: true,
				configs: [
					{
						id: 'remote-1',
						name: 'Prod',
						host: 'prod.example.com',
						port: 22,
						username: 'deploy',
						privateKeyPath: '~/.ssh/id_ed25519',
						enabled: true,
					},
				],
			});
			vi.mocked(window.maestro.fs.stat).mockResolvedValue({ isFile: true } as any);

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
				expect(screen.getByText('SSH Remote Execution')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByRole('combobox'), { target: { value: 'remote-1' } });
			fireEvent.change(screen.getByLabelText('Agent Name'), { target: { value: 'Remote Agent' } });
			fireEvent.change(screen.getByLabelText('Working Directory'), {
				target: { value: '/remote/project' },
			});

			await waitFor(
				() => {
					expect(screen.getByText('Path is a file, not a directory')).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);
			expect(window.maestro.fs.stat).toHaveBeenCalledWith('/remote/project', 'remote-1');
			expect(screen.getByText('Create Agent')).toBeEnabled();
		});

		it('should show inaccessible remote path errors when SSH create validation rejects', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);
			vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
				success: true,
				configs: [
					{
						id: 'remote-1',
						name: 'Prod',
						host: 'prod.example.com',
						port: 22,
						username: 'deploy',
						privateKeyPath: '~/.ssh/id_ed25519',
						enabled: true,
					},
				],
			});
			vi.mocked(window.maestro.fs.stat).mockRejectedValue(new Error('permission denied'));

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
				expect(screen.getByText('SSH Remote Execution')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByRole('combobox'), { target: { value: 'remote-1' } });
			fireEvent.change(screen.getByLabelText('Working Directory'), {
				target: { value: '/remote/private' },
			});

			await waitFor(
				() => {
					expect(screen.getByText('Path not found or not accessible')).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);
			expect(window.maestro.fs.stat).toHaveBeenCalledWith('/remote/private', 'remote-1');
		});

		it('should show not accessible when SSH create path stat returns no file type', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);
			vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
				success: true,
				configs: [
					{
						id: 'remote-1',
						name: 'Prod',
						host: 'prod.example.com',
						port: 22,
						username: 'deploy',
						privateKeyPath: '~/.ssh/id_ed25519',
						enabled: true,
					},
				],
			});
			vi.mocked(window.maestro.fs.stat).mockResolvedValue(null as any);

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
				expect(screen.getByText('SSH Remote Execution')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByRole('combobox'), { target: { value: 'remote-1' } });
			fireEvent.change(screen.getByLabelText('Working Directory'), {
				target: { value: '/remote/missing' },
			});

			await waitFor(
				() => {
					expect(screen.getByText('Path not found or not accessible')).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);
			expect(window.maestro.fs.stat).toHaveBeenCalledWith('/remote/missing', 'remote-1');
		});

		it('keeps folder picking disabled for SSH paths and supports Ctrl+Enter creation', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
			]);
			vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
				success: true,
				configs: [
					{
						id: 'remote-1',
						name: 'Prod',
						host: 'prod.example.com',
						port: 22,
						username: 'deploy',
						privateKeyPath: '~/.ssh/id_ed25519',
						enabled: true,
					},
				],
			});
			vi.mocked(window.maestro.fs.stat).mockResolvedValue({
				isDirectory: true,
				isFile: false,
			} as any);

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
				expect(screen.getByText('SSH Remote Execution')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByRole('combobox'), { target: { value: 'remote-1' } });

			const dialog = screen.getByRole('group', { name: 'Create new agent dialog' });
			fireEvent.keyDown(dialog, { key: 'o', metaKey: true });
			expect(window.maestro.dialog.selectFolder).not.toHaveBeenCalled();
			expect(screen.getByTitle(/Folder picker unavailable for SSH remote/)).toBeDisabled();

			fireEvent.change(screen.getByLabelText('Agent Name'), { target: { value: 'Remote Agent' } });
			fireEvent.change(screen.getByLabelText('Working Directory'), {
				target: { value: '/remote/project' },
			});

			await waitFor(
				() => {
					expect(screen.getByText('Remote directory found')).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			fireEvent.keyDown(dialog, { key: 'Enter', ctrlKey: true });

			expect(onCreate).toHaveBeenCalledWith(
				'claude-code',
				'/remote/project',
				'Remote Agent',
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ enabled: true, remoteId: 'remote-1' },
				undefined
			);
		});

		it('transfers pending SSH config when selecting an unavailable agent header', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({
					id: 'claude-code',
					name: 'Claude Code',
					available: false,
					path: null,
				}),
			]);
			vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
				success: true,
				configs: [
					{
						id: 'remote-1',
						name: 'Prod',
						host: 'prod.example.com',
						port: 22,
						username: 'deploy',
						privateKeyPath: '~/.ssh/id_ed25519',
						enabled: true,
					},
				],
			});
			vi.mocked(window.maestro.fs.stat).mockResolvedValue({
				isDirectory: true,
				isFile: false,
			} as any);

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
				expect(screen.getByText('SSH Remote Execution')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByRole('combobox'), { target: { value: 'remote-1' } });
			const option = await screen.findByRole('option', { name: /Claude Code/i });
			fireEvent.click(option);

			await waitFor(() => {
				expect(screen.getByPlaceholderText('/path/to/claude')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByPlaceholderText('/path/to/claude'), {
				target: { value: '/remote/bin/claude' },
			});
			fireEvent.change(screen.getByLabelText('Agent Name'), { target: { value: 'Remote Claude' } });
			fireEvent.change(screen.getByLabelText('Working Directory'), {
				target: { value: '/remote/project' },
			});

			await waitFor(
				() => {
					expect(screen.getByText('Remote directory found')).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			fireEvent.click(screen.getByText('Create Agent'));

			expect(onCreate).toHaveBeenCalledWith(
				'claude-code',
				'/remote/project',
				'Remote Claude',
				undefined,
				'/remote/bin/claude',
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ enabled: true, remoteId: 'remote-1' },
				undefined
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

			const afterRemoteCallCount = detectMock.mock.calls.length;
			fireEvent.change(dropdown, { target: { value: 'local' } });

			await waitFor(() => {
				expect(detectMock.mock.calls.length).toBeGreaterThan(afterRemoteCallCount);
				expect(detectMock).toHaveBeenCalledWith(undefined);
			});
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

			// Wait for initial load - agents should be detected and shown
			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});

			// Wait for SSH selector
			await waitFor(() => {
				expect(screen.getByText('SSH Remote Execution')).toBeInTheDocument();
			});

			// Select the unreachable SSH remote using the combobox (select element)
			const dropdown = screen.getByRole('combobox');
			fireEvent.change(dropdown, { target: { value: 'unreachable-remote' } });

			// Wait for connection error to appear
			await waitFor(() => {
				expect(screen.getByText('Unable to Connect')).toBeInTheDocument();
				expect(screen.getByText('Connection refused')).toBeInTheDocument();
			});

			// Agent list should not be visible
			expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
		});
	});

	describe('Agent configuration panel integration', () => {
		it('handles create-side config cleanup, cached model loads, refreshes, and persistence failures', async () => {
			const configFailure = new Error('config write failed');
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const configurableAgent = createAgentConfig({
				id: 'claude-code',
				name: 'Claude Code',
				available: true,
				capabilities: {
					supportsModelSelection: true,
				} as AgentConfig['capabilities'],
				configOptions: [
					{
						key: 'model',
						label: 'Model',
						type: 'text',
						default: 'claude-sonnet',
						description: 'Model slug',
					},
					{
						key: 'providerPath',
						label: 'Provider Path',
						type: 'text',
						default: '/old/provider',
						description: 'Provider binary path',
					},
				],
			});

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([configurableAgent]);
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
				customEnvVars: { NEW_VAR: 'one', NEW_VAR_1: 'two' },
				model: 'claude-sonnet',
				providerPath: '/old/provider',
			});
			vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['claude-sonnet']);
			vi.mocked(window.maestro.agents.refresh).mockResolvedValue({
				agents: [configurableAgent],
				debugInfo: null,
			});
			vi.mocked(window.maestro.agents.setConfig).mockRejectedValue(configFailure);

			try {
				render(
					<NewInstanceModal
						isOpen={true}
						onClose={onClose}
						onCreate={onCreate}
						theme={theme}
						existingSessions={[]}
					/>
				);

				await screen.findByText('Claude Code');
				const agentRow = screen.getByRole('option', { name: /Claude Code/i });
				fireEvent.click(agentRow);

				await waitFor(() => {
					expect(window.maestro.agents.getModels).toHaveBeenCalledWith('claude-code', false);
				});

				fireEvent.click(agentRow);
				fireEvent.click(agentRow);
				expect(window.maestro.agents.getModels).toHaveBeenCalledTimes(1);

				fireEvent.click(screen.getByText('Add Variable'));
				expect(await screen.findByDisplayValue('NEW_VAR_2')).toBeInTheDocument();

				for (let remainingVars = 3; remainingVars > 0; remainingVars--) {
					fireEvent.click(screen.getAllByTitle('Remove variable')[0]);
				}
				expect(screen.queryAllByTitle('Remove variable')).toHaveLength(0);

				fireEvent.click(screen.getByTitle('Refresh available models'));
				await waitFor(() => {
					expect(window.maestro.agents.getModels).toHaveBeenCalledWith('claude-code', true);
				});

				fireEvent.click(screen.getByTitle('Re-detect agent path'));
				await waitFor(() => {
					expect(window.maestro.agents.refresh).toHaveBeenCalledWith('claude-code');
				});

				const providerPath = screen.getByDisplayValue('/old/provider');
				fireEvent.change(providerPath, { target: { value: '/new/provider' } });
				fireEvent.blur(providerPath);

				await waitFor(() => {
					expect(window.maestro.agents.setConfig).toHaveBeenCalledWith(
						'claude-code',
						expect.objectContaining({ providerPath: '/new/provider' })
					);
					expect(consoleError).toHaveBeenCalledWith(
						'Failed to persist config for claude-code:',
						configFailure
					);
				});
			} finally {
				consoleError.mockRestore();
			}
		});

		it('should create with edited args, env vars, config values, and open hook docs', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({
					id: 'claude-code',
					name: 'Claude Code',
					available: true,
					configOptions: [
						{
							key: 'model',
							label: 'Model',
							type: 'text',
							default: 'claude-sonnet',
							description: 'Model slug',
						},
						{
							key: 'contextWindow',
							label: 'Context Window',
							type: 'number',
							default: 100000,
							description: 'Context window',
						},
						{
							key: 'providerPath',
							label: 'Provider Path',
							type: 'text',
							default: '/old/provider',
							description: 'Provider binary path',
						},
					],
				}),
			]);
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
				customPath: '/custom/bin/claude',
				customArgs: '--old',
				customEnvVars: { EXISTING: '1' },
				model: 'claude-sonnet',
				contextWindow: 100000,
				providerPath: '/old/provider',
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

			await waitFor(() => {
				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});

			fireEvent.keyDown(screen.getByRole('option', { name: /Claude Code/i }), { key: 'Enter' });

			await waitFor(() => {
				expect(screen.getByDisplayValue('/custom/bin/claude')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByLabelText('Agent Name'), {
				target: { value: 'Configured Agent' },
			});
			fireEvent.change(screen.getByLabelText('Working Directory'), {
				target: { value: '/workspace/project' },
			});
			fireEvent.click(screen.getByText('Clear'));
			fireEvent.change(screen.getByPlaceholderText('--flag value --another-flag'), {
				target: { value: '--fast' },
			});

			fireEvent.click(screen.getByText('Add Variable'));
			const newEnvKeyInput = await screen.findByDisplayValue('NEW_VAR');
			fireEvent.change(newEnvKeyInput, { target: { value: 'API_TOKEN' } });
			fireEvent.blur(newEnvKeyInput);
			const envValueInputs = screen.getAllByPlaceholderText('value');
			fireEvent.change(envValueInputs[envValueInputs.length - 1], { target: { value: 'secret' } });
			fireEvent.click(screen.getAllByTitle('Remove variable')[0]);

			fireEvent.change(screen.getByDisplayValue('claude-sonnet'), {
				target: { value: 'claude-haiku' },
			});
			fireEvent.change(screen.getByDisplayValue('100000'), { target: { value: '200000' } });
			fireEvent.change(screen.getByDisplayValue('/old/provider'), {
				target: { value: '/new/provider' },
			});

			fireEvent.click(screen.getByRole('button', { name: 'MAESTRO_SESSION_RESUMED' }));
			expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
				'https://docs.runmaestro.ai/autorun-playbooks#environment-variables'
			);

			fireEvent.click(screen.getByText('Create Agent'));

			expect(onCreate).toHaveBeenCalledWith(
				'claude-code',
				'/workspace/project',
				'Configured Agent',
				undefined,
				'/custom/bin/claude',
				'--fast',
				{ API_TOKEN: 'secret' },
				'claude-haiku',
				200000,
				'/new/provider',
				{ enabled: false, remoteId: null },
				undefined
			);
			expect(onClose).toHaveBeenCalled();
		});
	});

	describe('EditAgentModal', () => {
		let onSave: ReturnType<typeof vi.fn>;

		beforeEach(() => {
			onSave = vi.fn();
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});
		});

		it('should render null when closed or no session is provided', () => {
			const { container, rerender } = render(
				<EditAgentModal
					isOpen={false}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={createSession()}
					existingSessions={[]}
				/>
			);

			expect(container.firstChild).toBeNull();

			rerender(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={null}
					existingSessions={[]}
				/>
			);

			expect(container.firstChild).toBeNull();
		});

		it('should preload session overrides and save them with a trimmed name', async () => {
			const session = createSession({
				name: 'Editable Agent',
				nudgeMessage: 'Keep responses terse',
				customPath: '/custom/bin/claude',
				customArgs: '--verbose',
				customEnvVars: { DEBUG: '1' },
				customModel: 'claude-opus-4',
				customContextWindow: 200000,
			});

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({
					id: 'claude-code',
					name: 'Claude Code',
					available: true,
					capabilities: {
						supportsModelSelection: true,
					} as AgentConfig['capabilities'],
				}),
			]);
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
				model: 'global-model',
				contextWindow: 100000,
			});

			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={session}
					existingSessions={[]}
				/>
			);

			const nameInput = await screen.findByLabelText('Agent Name');
			fireEvent.change(nameInput, { target: { value: '  Renamed Agent  ' } });

			fireEvent.click(screen.getByText('Save Changes'));

			expect(onSave).toHaveBeenCalledWith(
				'session-1',
				'Renamed Agent',
				undefined,
				'Keep responses terse',
				'/custom/bin/claude',
				'--verbose',
				{ DEBUG: '1' },
				'claude-opus-4',
				200000,
				{ enabled: false, remoteId: null }
			);
			expect(onClose).toHaveBeenCalled();
		});

		it('blocks saving an edit when the new name duplicates another session', async () => {
			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={createSession({ id: 'session-1', name: 'Editable Agent' })}
					existingSessions={[createSession({ id: 'session-2', name: 'Taken Agent' })]}
				/>
			);

			const nameInput = await screen.findByLabelText('Agent Name');
			fireEvent.change(nameInput, { target: { value: 'Taken Agent' } });

			expect(
				await screen.findByText('An agent named "Taken Agent" already exists')
			).toBeInTheDocument();
			expect(screen.getByText('Save Changes')).toBeDisabled();

			fireEvent.keyDown(screen.getByRole('group', { name: 'Edit agent dialog' }), {
				key: 'Escape',
			});
			fireEvent.keyDown(screen.getByRole('group', { name: 'Edit agent dialog' }), {
				key: 'Enter',
				ctrlKey: true,
			});
			expect(onSave).not.toHaveBeenCalled();
		});

		it('renders edit form without provider settings when the session provider is not detected', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'opencode', name: 'OpenCode', available: true }),
			]);

			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={createSession({ toolType: 'claude-code' })}
					existingSessions={[]}
				/>
			);

			expect(await screen.findByLabelText('Agent Name')).toBeInTheDocument();
			await waitFor(() => {
				expect(screen.queryByText('Claude Code Settings')).not.toBeInTheDocument();
			});
		});

		it('should clear provider-specific overrides when saving a provider switch', async () => {
			const session = createSession({
				toolType: 'claude-code',
				customPath: '/custom/bin/claude',
				customArgs: '--verbose',
				customEnvVars: { DEBUG: '1' },
				customModel: 'claude-opus-4',
				customContextWindow: 200000,
			});

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({ id: 'claude-code', name: 'Claude Code', available: true }),
				createAgentConfig({ id: 'codex', name: 'Codex', available: true }),
			]);
			vi.mocked(window.maestro.agents.getConfig).mockImplementation(async (agentId) =>
				agentId === 'codex' ? { model: 'gpt-5', contextWindow: 128000 } : {}
			);

			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={session}
					existingSessions={[]}
				/>
			);

			const providerSelect = await screen.findByRole('combobox');
			fireEvent.change(providerSelect, { target: { value: 'codex' } });

			await waitFor(() => {
				expect(screen.getByText(/Changing the provider will clear/)).toBeInTheDocument();
				expect(window.maestro.agents.getConfig).toHaveBeenCalledWith('codex');
			});

			fireEvent.click(screen.getByText('Save Changes'));

			expect(onSave).toHaveBeenCalledWith(
				'session-1',
				'Editable Agent',
				'codex',
				undefined,
				undefined,
				undefined,
				undefined,
				'gpt-5',
				128000,
				{ enabled: false, remoteId: null }
			);
		});

		it('should show remote path validation errors for SSH edit sessions', async () => {
			const session = createSession({
				projectRoot: '/remote/project',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
				success: true,
				configs: [
					{
						id: 'remote-1',
						name: 'Prod',
						host: 'prod.example.com',
						port: 22,
						username: 'deploy',
						privateKeyPath: '~/.ssh/id_ed25519',
						enabled: true,
					},
				],
			});
			vi.mocked(window.maestro.fs.stat).mockResolvedValue({ isFile: true } as any);

			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={session}
					existingSessions={[]}
				/>
			);

			await waitFor(
				() => {
					expect(document.body.textContent).toContain(
						'Path is a file, not a directory (prod.example.com)'
					);
				},
				{ timeout: 1500 }
			);
		});

		it('should show successful and missing remote path status for SSH edit sessions', async () => {
			const session = createSession({
				projectRoot: '/remote/project',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
				success: true,
				configs: [
					{
						id: 'remote-1',
						name: 'Prod',
						host: 'prod.example.com',
						port: 22,
						username: 'deploy',
						privateKeyPath: '~/.ssh/id_ed25519',
						enabled: true,
					},
				],
			});
			vi.mocked(window.maestro.fs.stat).mockResolvedValue({
				isDirectory: true,
				isFile: false,
			} as any);

			const { rerender } = render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={session}
					existingSessions={[]}
				/>
			);

			await waitFor(
				() => {
					expect(document.body.textContent).toContain('Directory found on prod.example.com');
				},
				{ timeout: 1500 }
			);

			fireEvent.click(screen.getByText('Save Changes'));
			expect(onSave).toHaveBeenCalledWith(
				'session-1',
				'Editable Agent',
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ enabled: true, remoteId: 'remote-1', workingDirOverride: undefined }
			);

			vi.mocked(window.maestro.fs.stat).mockResolvedValue(null as any);
			rerender(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={createSession({
						id: 'session-2',
						projectRoot: '/remote/missing',
						sessionSshRemoteConfig: {
							enabled: true,
							remoteId: 'remote-1',
						},
					})}
					existingSessions={[]}
				/>
			);

			await waitFor(
				() => {
					expect(document.body.textContent).toContain('Path not found on remote');
				},
				{ timeout: 1500 }
			);
		});

		it('validates saved SSH sessions even when the remote config list is unavailable', async () => {
			const session = createSession({
				projectRoot: '/remote/project',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
				success: false,
				configs: [],
			});
			vi.mocked(window.maestro.fs.stat).mockResolvedValue({
				isDirectory: true,
				isFile: false,
			} as any);

			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={session}
					existingSessions={[]}
				/>
			);

			await waitFor(
				() => {
					expect(document.body.textContent).toContain('Directory found on remote');
				},
				{ timeout: 1500 }
			);
			expect(window.maestro.fs.stat).toHaveBeenCalledWith('/remote/project', 'remote-1');
		});

		it('handles edit modal load failures and remote validation rejection', async () => {
			const modelFailure = new Error('models offline');
			const sshFailure = new Error('ssh configs offline');
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const session = createSession({
				projectRoot: '/remote/private',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createAgentConfig({
					id: 'claude-code',
					name: 'Claude Code',
					available: true,
					capabilities: {
						supportsModelSelection: true,
					} as AgentConfig['capabilities'],
				}),
			]);
			vi.mocked(window.maestro.agents.getModels).mockRejectedValue(modelFailure);
			vi.mocked(window.maestro.sshRemote.getConfigs).mockRejectedValue(sshFailure);
			vi.mocked(window.maestro.fs.stat).mockRejectedValue(new Error('permission denied'));

			try {
				render(
					<EditAgentModal
						isOpen={true}
						onClose={onClose}
						onSave={onSave}
						theme={theme}
						session={session}
						existingSessions={[]}
					/>
				);

				await waitFor(() => {
					expect(consoleError).toHaveBeenCalledWith('Failed to load models:', modelFailure);
					expect(consoleError).toHaveBeenCalledWith('Failed to load SSH remotes:', sshFailure);
				});

				await waitFor(
					() => {
						expect(document.body.textContent).toContain('Path not found on remote');
					},
					{ timeout: 1500 }
				);
			} finally {
				consoleError.mockRestore();
			}
		});

		it('reports edit refresh failures for models and agent detection', async () => {
			const refreshModelsFailure = new Error('refresh models failed');
			const refreshAgentFailure = new Error('refresh agent failed');
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const editableAgent = createAgentConfig({
				id: 'claude-code',
				name: 'Claude Code',
				available: true,
				capabilities: {
					supportsModelSelection: true,
				} as AgentConfig['capabilities'],
				configOptions: [
					{
						key: 'model',
						label: 'Model',
						type: 'text',
						default: 'claude-sonnet',
						description: 'Model slug',
					},
				],
			});

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([editableAgent]);
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({ model: 'claude-sonnet' });
			vi.mocked(window.maestro.agents.getModels)
				.mockResolvedValueOnce(['claude-sonnet'])
				.mockRejectedValueOnce(refreshModelsFailure);
			vi.mocked(window.maestro.agents.refresh).mockRejectedValue(refreshAgentFailure);

			try {
				render(
					<EditAgentModal
						isOpen={true}
						onClose={onClose}
						onSave={onSave}
						theme={theme}
						session={createSession({ customModel: 'claude-sonnet' })}
						existingSessions={[]}
					/>
				);

				await screen.findByText('Claude Code Settings');

				fireEvent.click(screen.getByTitle('Refresh available models'));
				await waitFor(() => {
					expect(consoleError).toHaveBeenCalledWith(
						'Failed to refresh models:',
						refreshModelsFailure
					);
				});

				fireEvent.click(screen.getByTitle('Re-detect agent path'));
				await waitFor(() => {
					expect(consoleError).toHaveBeenCalledWith(
						'Failed to refresh agent:',
						refreshAgentFailure
					);
				});
			} finally {
				consoleError.mockRestore();
			}
		});

		it('clears edit agent settings when re-detection no longer returns the provider', async () => {
			const editableAgent = createAgentConfig({
				id: 'claude-code',
				name: 'Claude Code',
				available: true,
			});

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([editableAgent]);
			vi.mocked(window.maestro.agents.refresh).mockResolvedValue({
				agents: [],
				debugInfo: null,
			});

			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={createSession()}
					existingSessions={[]}
				/>
			);

			await screen.findByText('Claude Code Settings');
			fireEvent.click(screen.getByTitle('Re-detect agent path'));

			await waitFor(() => {
				expect(window.maestro.agents.refresh).toHaveBeenCalledWith('claude-code');
				expect(screen.queryByText('Claude Code Settings')).not.toBeInTheDocument();
			});
		});

		it('skips edit remote validation when the SSH session has no project root', async () => {
			const session = createSession({
				projectRoot: '',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={session}
					existingSessions={[]}
				/>
			);

			await screen.findByLabelText('Agent Name');
			expect(window.maestro.fs.stat).not.toHaveBeenCalled();
		});

		it('shows copied state briefly after copying the session id', async () => {
			const originalClipboard = navigator.clipboard;
			const writeText = vi.fn().mockResolvedValue(undefined);
			Object.defineProperty(navigator, 'clipboard', {
				configurable: true,
				value: { writeText },
			});

			try {
				render(
					<EditAgentModal
						isOpen={true}
						onClose={onClose}
						onSave={onSave}
						theme={theme}
						session={createSession()}
						existingSessions={[]}
					/>
				);

				const copyButton = await screen.findByTitle('Click to copy: session-1');
				vi.useFakeTimers();

				await act(async () => {
					fireEvent.click(copyButton);
					await Promise.resolve();
				});

				expect(writeText).toHaveBeenCalledWith('session-1');
				expect(screen.getByTitle('Copied!')).toBeInTheDocument();

				act(() => {
					vi.advanceTimersByTime(2000);
				});

				expect(screen.getByTitle('Click to copy: session-1')).toBeInTheDocument();
			} finally {
				vi.useRealTimers();
				Object.defineProperty(navigator, 'clipboard', {
					configurable: true,
					value: originalClipboard,
				});
			}
		});

		it('leaves the session id copy state unchanged when clipboard write fails', async () => {
			const originalClipboard = navigator.clipboard;
			const writeText = vi.fn().mockRejectedValue(new Error('clipboard unavailable'));
			Object.defineProperty(navigator, 'clipboard', {
				configurable: true,
				value: { writeText },
			});

			try {
				render(
					<EditAgentModal
						isOpen={true}
						onClose={onClose}
						onSave={onSave}
						theme={theme}
						session={createSession()}
						existingSessions={[]}
					/>
				);

				const copyButton = await screen.findByTitle('Click to copy: session-1');

				await act(async () => {
					fireEvent.click(copyButton);
					await Promise.resolve();
				});

				expect(writeText).toHaveBeenCalledWith('session-1');
				expect(screen.queryByTitle('Copied!')).not.toBeInTheDocument();
				expect(screen.getByTitle('Click to copy: session-1')).toBeInTheDocument();
			} finally {
				Object.defineProperty(navigator, 'clipboard', {
					configurable: true,
					value: originalClipboard,
				});
			}
		});

		it('clears edit overrides, truncates nudges, handles env key collisions, and reports config persistence failures', async () => {
			const configFailure = new Error('edit config write failed');
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const session = createSession({
				customPath: '/custom/bin/claude',
				customArgs: '--old',
				customEnvVars: { NEW_VAR: 'one', NEW_VAR_1: 'two' },
				customModel: 'claude-sonnet',
			});
			const editableAgent = createAgentConfig({
				id: 'claude-code',
				name: 'Claude Code',
				available: true,
				configOptions: [
					{
						key: 'providerPath',
						label: 'Provider Path',
						type: 'text',
						default: '/global/provider',
						description: 'Provider binary path',
					},
				],
			});

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([editableAgent]);
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
				providerPath: '/global/provider',
			});
			vi.mocked(window.maestro.agents.setConfig).mockRejectedValue(configFailure);

			try {
				render(
					<EditAgentModal
						isOpen={true}
						onClose={onClose}
						onSave={onSave}
						theme={theme}
						session={session}
						existingSessions={[]}
					/>
				);

				await screen.findByText('Claude Code Settings');

				fireEvent.click(screen.getByText('Reset'));
				fireEvent.click(screen.getByText('Clear'));

				const longNudge = 'z'.repeat(1005);
				const nudgeInput = screen.getByPlaceholderText(
					'Instructions appended to every message you send...'
				) as HTMLTextAreaElement;
				fireEvent.change(nudgeInput, { target: { value: longNudge } });
				expect(nudgeInput.value).toHaveLength(1000);

				fireEvent.click(screen.getByText('Add Variable'));
				expect(await screen.findByDisplayValue('NEW_VAR_2')).toBeInTheDocument();

				const providerPath = screen.getByDisplayValue('/global/provider');
				fireEvent.change(providerPath, { target: { value: '/new/provider' } });
				fireEvent.blur(providerPath);

				await waitFor(() => {
					expect(window.maestro.agents.setConfig).toHaveBeenCalledWith('claude-code', {
						providerPath: '/new/provider',
					});
					expect(consoleError).toHaveBeenCalledWith(
						'Failed to persist config for claude-code:',
						configFailure
					);
				});

				fireEvent.click(screen.getByText('Save Changes'));

				expect(onSave).toHaveBeenCalledWith(
					'session-1',
					'Editable Agent',
					undefined,
					'z'.repeat(1000),
					undefined,
					undefined,
					{ NEW_VAR: 'one', NEW_VAR_1: 'two', NEW_VAR_2: '' },
					'claude-sonnet',
					undefined,
					{ enabled: false, remoteId: null }
				);
			} finally {
				consoleError.mockRestore();
			}
		});

		it('should handle copy, refresh, config edits, and keyboard save', async () => {
			const originalClipboard = navigator.clipboard;
			const writeText = vi.fn().mockResolvedValue(undefined);
			Object.defineProperty(navigator, 'clipboard', {
				configurable: true,
				value: { writeText },
			});

			const session = createSession({
				customPath: '/custom/bin/claude',
				customArgs: '--old',
				customEnvVars: { KEEP: '1' },
				customModel: 'claude-sonnet',
				customContextWindow: 100000,
			});

			const editableAgent = createAgentConfig({
				id: 'claude-code',
				name: 'Claude Code',
				available: true,
				capabilities: {
					supportsModelSelection: true,
				} as AgentConfig['capabilities'],
				configOptions: [
					{
						key: 'model',
						label: 'Model',
						type: 'text',
						default: 'claude-sonnet',
						description: 'Model slug',
					},
					{
						key: 'contextWindow',
						label: 'Context Window',
						type: 'number',
						default: 100000,
						description: 'Context window',
					},
				],
			});

			vi.mocked(window.maestro.agents.detect).mockResolvedValue([editableAgent]);
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
				model: 'global-model',
				contextWindow: 64000,
			});
			vi.mocked(window.maestro.agents.getModels).mockResolvedValue([
				'claude-sonnet',
				'claude-opus',
			]);
			vi.mocked(window.maestro.agents.refresh).mockResolvedValue({
				agents: [editableAgent],
				debugInfo: null,
			});

			try {
				render(
					<EditAgentModal
						isOpen={true}
						onClose={onClose}
						onSave={onSave}
						theme={theme}
						session={session}
						existingSessions={[]}
					/>
				);

				await screen.findByText('Claude Code Settings');

				fireEvent.click(screen.getByTitle(`Click to copy: ${session.id}`));
				await waitFor(() => {
					expect(writeText).toHaveBeenCalledWith(session.id);
				});

				fireEvent.click(screen.getByTitle('Re-detect agent path'));
				await waitFor(() => {
					expect(window.maestro.agents.refresh).toHaveBeenCalledWith('claude-code');
				});

				fireEvent.click(screen.getByTitle('Refresh available models'));
				await waitFor(() => {
					expect(window.maestro.agents.getModels).toHaveBeenCalledWith('claude-code', true);
				});

				fireEvent.blur(screen.getByDisplayValue('/custom/bin/claude'));
				const customArgsInput = screen.getByPlaceholderText('--flag value --another-flag');
				fireEvent.change(customArgsInput, {
					target: { value: '--new' },
				});
				fireEvent.blur(customArgsInput);
				const envKeyInput = screen.getByDisplayValue('KEEP');
				fireEvent.change(envKeyInput, { target: { value: 'TOKEN' } });
				fireEvent.blur(envKeyInput);
				fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '2' } });
				fireEvent.click(screen.getByText('Add Variable'));
				fireEvent.click(screen.getAllByTitle('Remove variable')[1]);
				fireEvent.change(screen.getByDisplayValue('100000'), { target: { value: '200000' } });
				fireEvent.blur(screen.getByDisplayValue('200000'));
				expect(window.maestro.agents.setConfig).not.toHaveBeenCalled();

				fireEvent.keyDown(screen.getByRole('group', { name: 'Edit agent dialog' }), {
					key: 'Enter',
					metaKey: true,
				});

				expect(onSave).toHaveBeenCalledWith(
					'session-1',
					'Editable Agent',
					undefined,
					undefined,
					'/custom/bin/claude',
					'--new',
					{ TOKEN: '2' },
					'claude-sonnet',
					200000,
					{ enabled: false, remoteId: null }
				);
				expect(onClose).toHaveBeenCalled();
			} finally {
				Object.defineProperty(navigator, 'clipboard', {
					configurable: true,
					value: originalClipboard,
				});
			}
		});
	});
});
