import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupChatModal } from '../../../renderer/components/GroupChatModal';
import type { AgentConfig, GroupChat, Theme } from '../../../renderer/types';

const agentConfigurationMock = vi.hoisted(() => ({
	useAgentConfiguration: vi.fn(),
}));

vi.mock('../../../renderer/hooks/agent', () => ({
	useAgentConfiguration: agentConfigurationMock.useAgentConfiguration,
}));

vi.mock('lucide-react', () => ({
	X: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="x-icon" className={className} style={style} />
	),
	Settings: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="settings-icon" className={className} style={style} />
	),
	ChevronDown: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="chevron-down-icon" className={className} style={style} />
	),
	Check: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="check-icon" className={className} style={style} />
	),
}));

vi.mock('../../../renderer/components/ui', async () => {
	const ReactActual = await vi.importActual<typeof import('react')>('react');

	return {
		Modal: ({
			title,
			onClose,
			children,
			footer,
			customHeader,
		}: {
			title: string;
			onClose: () => void;
			children: React.ReactNode;
			footer?: React.ReactNode;
			customHeader?: React.ReactNode;
		}) => (
			<div role="dialog" aria-label={title}>
				{customHeader ?? (
					<header>
						<h2>{title}</h2>
						<button type="button" aria-label="Close modal" onClick={onClose}>
							Close
						</button>
					</header>
				)}
				<div>{children}</div>
				<div>{footer}</div>
			</div>
		),
		ModalFooter: ({
			onCancel,
			onConfirm,
			confirmLabel = 'Confirm',
			confirmDisabled = false,
		}: {
			onCancel: () => void;
			onConfirm: () => void;
			confirmLabel?: string;
			confirmDisabled?: boolean;
		}) => (
			<>
				<button type="button" onClick={onCancel}>
					Cancel
				</button>
				<button type="button" disabled={confirmDisabled} onClick={onConfirm}>
					{confirmLabel}
				</button>
			</>
		),
		FormInput: ReactActual.forwardRef<
			HTMLInputElement,
			{
				label?: string;
				value: string;
				onChange: (value: string) => void;
				onSubmit?: () => void;
				placeholder?: string;
			}
		>(({ label, value, onChange, onSubmit, placeholder }, ref) => (
			<label>
				{label}
				<input
					ref={ref}
					value={value}
					placeholder={placeholder}
					onChange={(event) => onChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter' && onSubmit) {
							onSubmit();
						}
					}}
				/>
			</label>
		)),
	};
});

vi.mock('../../../renderer/components/shared/AgentConfigPanel', () => ({
	AgentConfigPanel: (props: any) => (
		<div data-testid="agent-config-panel">
			<div data-testid="config-agent-name">{props.agent.name}</div>
			<div data-testid="available-models">{props.availableModels.length}</div>
			<button type="button" onClick={() => props.onCustomPathClear()}>
				Clear Path
			</button>
			<button type="button" onClick={() => props.onCustomArgsClear()}>
				Clear Args
			</button>
			<button type="button" onClick={() => props.onEnvVarAdd()}>
				Add Env
			</button>
			<button type="button" onClick={() => props.onEnvVarKeyChange('NEW_VAR', 'API_KEY', '')}>
				Rename Env
			</button>
			<button type="button" onClick={() => props.onEnvVarValueChange('API_KEY', 'secret')}>
				Set Env Value
			</button>
			<button type="button" onClick={() => props.onEnvVarRemove('API_KEY')}>
				Remove Env
			</button>
			<button type="button" onClick={() => props.onConfigChange('model', 'gpt-5')}>
				Change Model
			</button>
			<button type="button" onClick={() => props.onConfigBlur()}>
				Save Model
			</button>
			<button type="button" onClick={() => props.onRefreshModels()}>
				Refresh Models
			</button>
			<button type="button" onClick={() => props.onRefreshAgent()}>
				Refresh Agent
			</button>
		</div>
	),
}));

vi.mock('../../../renderer/components/shared/SshRemoteSelector', () => ({
	SshRemoteSelector: (props: any) => (
		<div data-testid="ssh-remote-selector">
			<button
				type="button"
				onClick={() =>
					props.onSshRemoteConfigChange({
						enabled: true,
						remoteId: props.sshRemotes[0]?.id ?? 'remote-1',
					})
				}
			>
				Use Remote
			</button>
		</div>
	),
}));

const theme: Theme = {
	id: 'custom',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#222222',
		bgActivity: '#333333',
		textMain: '#ffffff',
		textDim: '#999999',
		accent: '#00aaff',
		accentDim: '#00aaff33',
		accentText: '#00aaff',
		accentForeground: '#ffffff',
		border: '#444444',
		error: '#ff5555',
		warning: '#ffaa00',
		success: '#22cc88',
	},
};

const agent = (id: string, name: string, overrides: Partial<AgentConfig> = {}): AgentConfig => ({
	id,
	name,
	command: id,
	args: [],
	available: true,
	path: `/usr/local/bin/${id}`,
	hidden: false,
	capabilities: {},
	...overrides,
});

const claudeAgent = agent('claude-code', 'Claude Code');
const codexAgent = agent('codex', 'Codex', {
	capabilities: { supportsModelSelection: true } as any,
});

function createAgentConfiguration(overrides: Record<string, unknown> = {}) {
	const agentConfig = { model: '' };

	return {
		isDetecting: false,
		detectedAgents: [claudeAgent, codexAgent],
		selectedAgent: 'claude-code',
		setSelectedAgent: vi.fn(),
		handleAgentChange: vi.fn(),
		customPath: '',
		setCustomPath: vi.fn(),
		customArgs: '',
		setCustomArgs: vi.fn(),
		customEnvVars: {},
		setCustomEnvVars: vi.fn(),
		agentConfig,
		setAgentConfig: vi.fn(),
		agentConfigRef: { current: agentConfig },
		availableModels: [],
		loadingModels: false,
		refreshModels: vi.fn(),
		refreshAgent: vi.fn(),
		refreshingAgent: false,
		saveAgentConfig: vi.fn().mockResolvedValue(undefined),
		isConfigExpanded: false,
		toggleConfigExpanded: vi.fn(),
		hasCustomization: false,
		sshRemotes: [],
		sshRemoteConfig: undefined,
		setSshRemoteConfig: vi.fn(),
		...overrides,
	};
}

function renderCreateModal(ac = createAgentConfiguration()) {
	agentConfigurationMock.useAgentConfiguration.mockReturnValue(ac);
	const props: React.ComponentProps<typeof GroupChatModal> = {
		mode: 'create',
		theme,
		isOpen: true,
		onClose: vi.fn(),
		onCreate: vi.fn(),
	};

	return { ...render(<GroupChatModal {...props} />), props, ac };
}

function createGroupChat(overrides: Partial<GroupChat> = {}): GroupChat {
	return {
		id: 'group-1',
		name: 'Planning Room',
		createdAt: 1700000000000,
		updatedAt: 1700000001000,
		moderatorAgentId: 'claude-code',
		moderatorSessionId: 'group-chat-group-1-moderator',
		moderatorConfig: {
			customPath: '/usr/local/bin/claude',
			customArgs: '--fast',
			customEnvVars: { TEAM: 'infra' },
			customModel: 'claude-3-5-sonnet',
			sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		},
		participants: [],
		logPath: '/tmp/group-1.log',
		imagesDir: '/tmp/group-1-images',
		...overrides,
	};
}

function renderEditModal(groupChat: GroupChat | null, ac = createAgentConfiguration()) {
	agentConfigurationMock.useAgentConfiguration.mockReturnValue(ac);
	const props: React.ComponentProps<typeof GroupChatModal> = {
		mode: 'edit',
		theme,
		isOpen: true,
		onClose: vi.fn(),
		onSave: vi.fn(),
		groupChat,
	};

	return { ...render(<GroupChatModal {...props} />), props, ac };
}

beforeEach(() => {
	agentConfigurationMock.useAgentConfiguration.mockReset();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('GroupChatModal', () => {
	it('does not render when closed or when edit mode has no group chat', () => {
		agentConfigurationMock.useAgentConfiguration.mockReturnValue(createAgentConfiguration());

		const { rerender } = render(
			<GroupChatModal
				mode="create"
				theme={theme}
				isOpen={false}
				onClose={vi.fn()}
				onCreate={vi.fn()}
			/>
		);

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

		rerender(
			<GroupChatModal
				mode="edit"
				theme={theme}
				isOpen
				onClose={vi.fn()}
				onSave={vi.fn()}
				groupChat={null}
			/>
		);

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});

	it('shows detection and empty-agent states in create mode', () => {
		const { rerender } = renderCreateModal(
			createAgentConfiguration({ isDetecting: true, detectedAgents: [], selectedAgent: null })
		);

		expect(screen.getByText('Detecting agents...')).toBeInTheDocument();

		const emptyAc = createAgentConfiguration({
			isDetecting: false,
			detectedAgents: [],
			selectedAgent: null,
		});
		agentConfigurationMock.useAgentConfiguration.mockReturnValue(emptyAc);
		rerender(
			<GroupChatModal mode="create" theme={theme} isOpen onClose={vi.fn()} onCreate={vi.fn()} />
		);

		expect(screen.getByText(/No agents available/i)).toBeInTheDocument();
		expect(emptyAc.setSelectedAgent).toHaveBeenCalledWith(null);
	});

	it('auto-selects the first supported detected agent or falls back to the first detected agent', async () => {
		const pendingAc = createAgentConfiguration({
			detectedAgents: [claudeAgent],
			selectedAgent: null,
		});
		const { unmount: unmountPending } = renderCreateModal(pendingAc);

		expect(screen.getByLabelText('Select moderator agent')).toHaveValue('claude-code');
		await waitFor(() => {
			expect(pendingAc.setSelectedAgent).toHaveBeenCalledWith('claude-code');
		});
		unmountPending();

		const supportedAc = createAgentConfiguration({
			detectedAgents: [codexAgent],
			selectedAgent: 'missing-agent',
		});
		const { unmount } = renderCreateModal(supportedAc);

		await waitFor(() => {
			expect(supportedAc.setSelectedAgent).toHaveBeenCalledWith('codex');
		});
		unmount();

		const unsupportedAgent = agent('gemini-cli', 'Gemini CLI');
		const fallbackAc = createAgentConfiguration({
			detectedAgents: [unsupportedAgent],
			selectedAgent: null,
		});
		renderCreateModal(fallbackAc);

		await waitFor(() => {
			expect(fallbackAc.setSelectedAgent).toHaveBeenCalledWith('gemini-cli');
		});
		expect(screen.getByText(/No agents available/i)).toBeInTheDocument();
	});

	it('creates a group chat without moderator config when no customization exists', () => {
		const ac = createAgentConfiguration({ selectedAgent: 'claude-code' });
		const { props } = renderCreateModal(ac);

		fireEvent.change(screen.getByLabelText('Chat Name'), {
			target: { value: 'Plain Room' },
		});
		fireEvent.change(screen.getByLabelText('Select moderator agent'), {
			target: { value: 'codex' },
		});
		expect(ac.handleAgentChange).toHaveBeenCalledWith('codex');

		fireEvent.click(screen.getByRole('button', { name: 'Create' }));

		expect(props.onCreate).toHaveBeenCalledWith('Plain Room', 'claude-code', undefined);
	});

	it('creates moderator config when only CLI args are customized', () => {
		const ac = createAgentConfiguration({ customArgs: '--debug' });
		const { props } = renderCreateModal(ac);

		fireEvent.change(screen.getByLabelText('Chat Name'), {
			target: { value: 'Args Room' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Create' }));

		expect(props.onCreate).toHaveBeenCalledWith('Args Room', 'claude-code', {
			customPath: undefined,
			customArgs: '--debug',
			customEnvVars: undefined,
			customModel: undefined,
			sshRemoteConfig: undefined,
		});
	});

	it('creates moderator config when only a model is customized', () => {
		const ac = createAgentConfiguration({ agentConfig: { model: 'gpt-5-mini' } });
		const { props } = renderCreateModal(ac);

		fireEvent.change(screen.getByLabelText('Chat Name'), {
			target: { value: 'Model Room' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Create' }));

		expect(props.onCreate).toHaveBeenCalledWith('Model Room', 'claude-code', {
			customPath: undefined,
			customArgs: undefined,
			customEnvVars: undefined,
			customModel: 'gpt-5-mini',
			sshRemoteConfig: undefined,
		});
	});

	it('creates a group chat with trimmed name and moderator customization', async () => {
		const ac = createAgentConfiguration({
			selectedAgent: 'codex',
			customPath: '/opt/codex',
			customArgs: '--json',
			customEnvVars: { API_KEY: 'secret' },
			agentConfig: { model: 'gpt-5' },
			sshRemotes: [{ id: 'remote-1', name: 'Build Box', host: 'build.example.com' }],
			sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});
		const { props } = renderCreateModal(ac);

		expect(screen.getByRole('dialog', { name: 'New Group Chat' })).toBeInTheDocument();
		expect(screen.getByText('Beta')).toBeInTheDocument();
		expect(screen.getByText(/A Group Chat lets you collaborate/i)).toBeInTheDocument();
		expect(screen.getByRole('option', { name: 'Codex' })).toBeInTheDocument();
		expect(screen.getByTestId('ssh-remote-selector')).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText('Chat Name'), {
			target: { value: '  Delivery Room  ' },
		});
		fireEvent.click(screen.getByText('Use Remote'));
		expect(ac.setSshRemoteConfig).toHaveBeenCalledWith({ enabled: true, remoteId: 'remote-1' });

		fireEvent.click(screen.getByRole('button', { name: 'Create' }));

		expect(props.onCreate).toHaveBeenCalledWith('Delivery Room', 'codex', {
			customPath: '/opt/codex',
			customArgs: '--json',
			customEnvVars: { API_KEY: 'secret' },
			customModel: 'gpt-5',
			sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});
		expect(props.onClose).toHaveBeenCalledOnce();
		await waitFor(() => expect(screen.getByLabelText('Chat Name')).toHaveValue(''));
	});

	it('wires expanded moderator configuration callbacks', async () => {
		const ac = createAgentConfiguration({
			selectedAgent: 'codex',
			isConfigExpanded: true,
			hasCustomization: true,
			customEnvVars: { NEW_VAR: 'taken' },
			agentConfig: { model: 'gpt-4.1' },
			agentConfigRef: { current: { model: 'gpt-4.1' } },
			availableModels: ['gpt-5'],
		});
		renderCreateModal(ac);

		expect(screen.getByText('Codex Configuration')).toBeInTheDocument();
		expect(screen.getByText('Customized')).toBeInTheDocument();
		expect(screen.getByTestId('agent-config-panel')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Clear Path'));
		expect(ac.setCustomPath).toHaveBeenCalledWith('');

		fireEvent.click(screen.getByText('Clear Args'));
		expect(ac.setCustomArgs).toHaveBeenCalledWith('');

		fireEvent.click(screen.getByText('Add Env'));
		expect(ac.setCustomEnvVars).toHaveBeenCalledWith({ NEW_VAR: 'taken', NEW_VAR_1: '' });

		fireEvent.click(screen.getByText('Rename Env'));
		expect(ac.setCustomEnvVars).toHaveBeenCalledWith({ API_KEY: '' });

		fireEvent.click(screen.getByText('Set Env Value'));
		expect(ac.setCustomEnvVars).toHaveBeenCalledWith({ NEW_VAR: 'taken', API_KEY: 'secret' });

		fireEvent.click(screen.getByText('Remove Env'));
		expect(ac.setCustomEnvVars).toHaveBeenCalledWith({ NEW_VAR: 'taken' });

		fireEvent.click(screen.getByText('Change Model'));
		expect(ac.setAgentConfig).toHaveBeenCalledWith({ model: 'gpt-5' });
		expect(ac.agentConfigRef.current).toEqual({ model: 'gpt-5' });

		fireEvent.click(screen.getByText('Save Model'));
		await waitFor(() => {
			expect(ac.saveAgentConfig).toHaveBeenCalledWith('codex');
		});

		fireEvent.click(screen.getByText('Refresh Models'));
		expect(ac.refreshModels).toHaveBeenCalledOnce();

		fireEvent.click(screen.getByText('Refresh Agent'));
		expect(ac.refreshAgent).toHaveBeenCalledOnce();
	});

	it('pre-populates edit mode, warns on moderator change, and saves updated values', async () => {
		const groupChat = createGroupChat();
		const ac = createAgentConfiguration({
			selectedAgent: 'codex',
			customPath: '/opt/codex',
			customArgs: '--json',
			customEnvVars: { TEAM: 'platform' },
			agentConfig: { model: 'gpt-5' },
		});
		const { props } = renderEditModal(groupChat, ac);

		await waitFor(() => {
			expect(screen.getByLabelText('Chat Name')).toHaveValue('Planning Room');
		});
		expect(ac.setSelectedAgent).toHaveBeenCalledWith('claude-code');
		expect(ac.setCustomPath).toHaveBeenCalledWith('/usr/local/bin/claude');
		expect(ac.setCustomArgs).toHaveBeenCalledWith('--fast');
		expect(ac.setCustomEnvVars).toHaveBeenCalledWith({ TEAM: 'infra' });
		expect(ac.setSshRemoteConfig).toHaveBeenCalledWith({
			enabled: true,
			remoteId: 'remote-1',
		});
		expect(screen.getByText(/Changing the moderator agent will restart/i)).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText('Chat Name'), {
			target: { value: '  Shipping Room  ' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(props.onSave).toHaveBeenCalledWith('group-1', 'Shipping Room', 'codex', {
			customPath: '/opt/codex',
			customArgs: '--json',
			customEnvVars: { TEAM: 'platform' },
			customModel: 'gpt-5',
		});
		expect(props.onClose).toHaveBeenCalledOnce();
	});

	it('marks edit mode as changed when config fields or saved model blur are used', async () => {
		const groupChat = createGroupChat({
			moderatorConfig: undefined,
		});
		const ac = createAgentConfiguration({
			selectedAgent: 'claude-code',
			isConfigExpanded: true,
			agentConfig: { model: '' },
			agentConfigRef: { current: { model: '' } },
		});
		const { props } = renderEditModal(groupChat, ac);

		await waitFor(() => {
			expect(screen.getByLabelText('Chat Name')).toHaveValue('Planning Room');
		});

		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

		fireEvent.click(screen.getByText('Change Model'));
		expect(ac.setAgentConfig).toHaveBeenCalledWith({ model: 'gpt-5' });
		expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();

		fireEvent.click(screen.getByText('Save Model'));
		await waitFor(() => {
			expect(ac.saveAgentConfig).toHaveBeenCalledWith('claude-code');
		});

		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(props.onSave).toHaveBeenCalledWith('group-1', 'Planning Room', 'claude-code', undefined);
	});

	it('returns null after an edit modal with local changes loses its group chat', () => {
		const groupChat = createGroupChat();
		const ac = createAgentConfiguration({ selectedAgent: 'claude-code' });
		agentConfigurationMock.useAgentConfiguration.mockReturnValue(ac);

		const props: React.ComponentProps<typeof GroupChatModal> = {
			mode: 'edit',
			theme,
			isOpen: true,
			onClose: vi.fn(),
			onSave: vi.fn(),
			groupChat,
		};
		const { rerender } = render(<GroupChatModal {...props} />);

		fireEvent.change(screen.getByLabelText('Chat Name'), {
			target: { value: 'Changed Room' },
		});

		rerender(<GroupChatModal {...props} groupChat={null} />);

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});
});
