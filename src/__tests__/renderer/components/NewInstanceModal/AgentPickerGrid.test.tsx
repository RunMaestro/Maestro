/**
 * @fileoverview Tests for AgentPickerGrid component
 * Tests: agent display, selection, expansion, badges, debug info, loading/error states
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentPickerGrid } from '../../../../renderer/components/NewInstanceModal/AgentPickerGrid';
import type { Theme, AgentConfig } from '../../../../renderer/types';
import type {
	AgentPickerGridProps,
	AgentDebugInfo,
} from '../../../../renderer/components/NewInstanceModal/types';

// lucide-react icons are mocked globally in src/__tests__/setup.ts using a Proxy

const createTheme = (): Theme =>
	({
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
	}) as Theme;

const createAgent = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
	id: 'claude-code',
	name: 'Claude Code',
	available: true,
	path: '/usr/local/bin/claude',
	binaryName: 'claude',
	hidden: false,
	...overrides,
});

const createDefaultProps = (
	overrides: Partial<AgentPickerGridProps> = {}
): AgentPickerGridProps => ({
	theme: createTheme(),
	loading: false,
	sshConnectionError: null,
	sortedAgents: [
		createAgent(),
		createAgent({ id: 'codex', name: 'OpenAI Codex', available: true, binaryName: 'codex' }),
	],
	selectedAgent: 'claude-code',
	expandedAgent: null,
	refreshingAgent: null,
	debugInfo: null,
	customAgentPaths: {},
	customAgentArgs: {},
	customAgentEnvVars: {},
	agentConfigs: {},
	availableModels: {},
	loadingModels: {},
	onAgentSelect: vi.fn(),
	onAgentExpand: vi.fn(),
	onRefreshAgent: vi.fn(),
	onDismissDebug: vi.fn(),
	onCustomPathChange: vi.fn(),
	onCustomArgsChange: vi.fn(),
	onEnvVarKeyChange: vi.fn(),
	onEnvVarValueChange: vi.fn(),
	onEnvVarRemove: vi.fn(),
	onEnvVarAdd: vi.fn(),
	onConfigChange: vi.fn(),
	onConfigBlur: vi.fn(),
	onRefreshModels: vi.fn(),
	onTransferPendingSshConfig: vi.fn(),
	onLoadModelsForAgent: vi.fn(),
	...overrides,
});

describe('AgentPickerGrid', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('should render loading spinner when loading', () => {
		render(<AgentPickerGrid {...createDefaultProps({ loading: true })} />);
		expect(screen.getByText('Loading agents...')).toBeInTheDocument();
	});

	it('should render SSH connection error panel', () => {
		render(
			<AgentPickerGrid
				{...createDefaultProps({
					sshConnectionError: 'Connection refused by remote host',
				})}
			/>
		);

		expect(screen.getByText('Unable to Connect')).toBeInTheDocument();
		expect(screen.getByText('Connection refused by remote host')).toBeInTheDocument();
		expect(
			screen.getByText('Select a different remote host or switch to Local Execution.')
		).toBeInTheDocument();
	});

	it('should render agent cards with correct names', () => {
		render(<AgentPickerGrid {...createDefaultProps()} />);
		expect(screen.getByText('Claude Code')).toBeInTheDocument();
		expect(screen.getByText('OpenAI Codex')).toBeInTheDocument();
	});

	it('should show Available badge for available agents', () => {
		render(<AgentPickerGrid {...createDefaultProps()} />);
		const availableBadges = screen.getAllByText('Available');
		expect(availableBadges.length).toBeGreaterThanOrEqual(1);
	});

	it('should show Not Found badge for unavailable agents', () => {
		render(
			<AgentPickerGrid
				{...createDefaultProps({
					sortedAgents: [createAgent({ available: false })],
				})}
			/>
		);

		expect(screen.getByText('Not Found')).toBeInTheDocument();
	});

	it('should show Coming Soon badge for unsupported agents', () => {
		render(
			<AgentPickerGrid
				{...createDefaultProps({
					sortedAgents: [
						createAgent({ id: 'future-agent', name: 'Future Agent', available: false }),
					],
				})}
			/>
		);

		expect(screen.getByText('Coming Soon')).toBeInTheDocument();
	});

	it('should call onAgentSelect and onAgentExpand when clicking supported agent', () => {
		const onAgentSelect = vi.fn();
		const onAgentExpand = vi.fn();
		const onTransferPendingSshConfig = vi.fn();

		render(
			<AgentPickerGrid
				{...createDefaultProps({
					onAgentSelect,
					onAgentExpand,
					onTransferPendingSshConfig,
					selectedAgent: '',
				})}
			/>
		);

		// Click the first agent (Claude Code)
		fireEvent.click(screen.getByText('Claude Code'));

		expect(onAgentSelect).toHaveBeenCalledWith('claude-code');
		expect(onAgentExpand).toHaveBeenCalledWith('claude-code');
		expect(onTransferPendingSshConfig).toHaveBeenCalledWith('claude-code');
	});

	it('should not call callbacks when clicking unsupported agent', () => {
		const onAgentSelect = vi.fn();
		const onAgentExpand = vi.fn();

		render(
			<AgentPickerGrid
				{...createDefaultProps({
					sortedAgents: [
						createAgent({ id: 'future-agent', name: 'Future Agent', available: false }),
					],
					onAgentSelect,
					onAgentExpand,
				})}
			/>
		);

		fireEvent.click(screen.getByText('Future Agent'));
		expect(onAgentSelect).not.toHaveBeenCalled();
		expect(onAgentExpand).not.toHaveBeenCalled();
	});

	it('should call onAgentExpand with null to collapse expanded agent', () => {
		const onAgentExpand = vi.fn();

		render(
			<AgentPickerGrid
				{...createDefaultProps({
					expandedAgent: 'claude-code',
					onAgentExpand,
				})}
			/>
		);

		// Click the already-expanded agent
		fireEvent.click(screen.getByText('Claude Code'));
		expect(onAgentExpand).toHaveBeenCalledWith(null);
	});

	it('should activate agent on keyboard Enter', () => {
		const onAgentSelect = vi.fn();

		render(
			<AgentPickerGrid
				{...createDefaultProps({
					onAgentSelect,
					selectedAgent: '',
				})}
			/>
		);

		const option = screen.getAllByRole('option')[0];
		fireEvent.keyDown(option, { key: 'Enter' });
		expect(onAgentSelect).toHaveBeenCalledWith('claude-code');
	});

	it('should activate agent on keyboard Space', () => {
		const onAgentSelect = vi.fn();

		render(
			<AgentPickerGrid
				{...createDefaultProps({
					onAgentSelect,
					selectedAgent: '',
				})}
			/>
		);

		const option = screen.getAllByRole('option')[0];
		fireEvent.keyDown(option, { key: ' ' });
		expect(onAgentSelect).toHaveBeenCalledWith('claude-code');
	});

	it('should call onRefreshAgent when refresh button is clicked', () => {
		const onRefreshAgent = vi.fn();

		render(<AgentPickerGrid {...createDefaultProps({ onRefreshAgent })} />);

		const refreshButtons = screen.getAllByTitle('Refresh detection');
		fireEvent.click(refreshButtons[0]);
		expect(onRefreshAgent).toHaveBeenCalledWith('claude-code');
	});

	it('should render debug info when present', () => {
		const debugInfo: AgentDebugInfo = {
			agentId: 'claude-code',
			available: false,
			path: null,
			binaryName: 'claude',
			envPath: '/usr/local/bin:/usr/bin',
			homeDir: '/home/testuser',
			platform: 'linux',
			whichCommand: 'which',
			error: 'Binary not found in PATH',
		};

		render(<AgentPickerGrid {...createDefaultProps({ debugInfo })} />);

		expect(screen.getByText(/Debug Info: claude not found/)).toBeInTheDocument();
		expect(screen.getByText('Binary not found in PATH')).toBeInTheDocument();
		expect(screen.getByText(/Platform:/)).toBeInTheDocument();
		expect(screen.getByText('linux')).toBeInTheDocument();
	});

	it('should call onDismissDebug when dismiss button is clicked', () => {
		const onDismissDebug = vi.fn();
		const debugInfo: AgentDebugInfo = {
			agentId: 'claude-code',
			available: false,
			path: null,
			binaryName: 'claude',
			envPath: '/usr/local/bin',
			homeDir: '/home/testuser',
			platform: 'linux',
			whichCommand: 'which',
			error: null,
		};

		render(<AgentPickerGrid {...createDefaultProps({ debugInfo, onDismissDebug })} />);

		fireEvent.click(screen.getByText('Dismiss'));
		expect(onDismissDebug).toHaveBeenCalled();
	});

	it('should render Agent Provider label', () => {
		render(<AgentPickerGrid {...createDefaultProps()} />);
		expect(screen.getByText('Agent Provider')).toBeInTheDocument();
	});

	it('should render hook behavior note', () => {
		render(<AgentPickerGrid {...createDefaultProps()} />);
		expect(screen.getByText(/Agent hooks run per-message/)).toBeInTheDocument();
		expect(screen.getByText('MAESTRO_SESSION_RESUMED')).toBeInTheDocument();
	});

	it('should set tabIndex=0 for supported agents and tabIndex=-1 for unsupported', () => {
		render(
			<AgentPickerGrid
				{...createDefaultProps({
					sortedAgents: [
						createAgent(),
						createAgent({ id: 'future-agent', name: 'Future', available: false }),
					],
				})}
			/>
		);

		const options = screen.getAllByRole('option');
		expect(options[0]).toHaveAttribute('tabindex', '0'); // claude-code (supported)
		expect(options[1]).toHaveAttribute('tabindex', '-1'); // future-agent (unsupported)
	});

	it('should set aria-selected on selected agent', () => {
		render(<AgentPickerGrid {...createDefaultProps({ selectedAgent: 'claude-code' })} />);

		const options = screen.getAllByRole('option');
		expect(options[0]).toHaveAttribute('aria-selected', 'true');
		expect(options[1]).toHaveAttribute('aria-selected', 'false');
	});
});
