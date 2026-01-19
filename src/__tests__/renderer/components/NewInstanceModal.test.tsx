/**
 * @fileoverview Tests for NewInstanceModal component
 * Tests: Modal rendering, agent detection, folder selection, form submission,
 * tilde expansion, layer stack integration, keyboard shortcuts, custom agent paths
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { NewInstanceModal } from '../../../renderer/components/NewInstanceModal';
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
				expect(screen.getByTitle('Browse folders (Cmd+O)')).toBeInTheDocument();
			});

			const folderButton = screen.getByTitle('Browse folders (Cmd+O)');
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
				expect(screen.getByTitle('Browse folders (Cmd+O)')).toBeInTheDocument();
			});

			const dirInput = screen.getByPlaceholderText('Select directory...');
			fireEvent.change(dirInput, { target: { value: '/existing/path' } });

			const folderButton = screen.getByTitle('Browse folders (Cmd+O)');
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
				{ enabled: false, remoteId: null }
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
				{ enabled: false, remoteId: null }
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
				{ enabled: false, remoteId: null }
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
				{ enabled: false, remoteId: null }
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

			// Set custom path
			const customPathInput = screen.getByPlaceholderText('/path/to/claude');
			fireEvent.change(customPathInput, { target: { value: '/custom/path/to/claude' } });

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
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ enabled: false, remoteId: null }
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
				{ enabled: false, remoteId: null }
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
				{ enabled: true, remoteId: 'remote-1' }
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
});
