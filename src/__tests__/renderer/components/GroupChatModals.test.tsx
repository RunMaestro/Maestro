import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteGroupChatModal } from '../../../renderer/components/DeleteGroupChatModal';
import { GroupChatModal } from '../../../renderer/components/GroupChatModal';
import { RenameGroupChatModal } from '../../../renderer/components/RenameGroupChatModal';
import type { AgentConfig, Theme } from '../../../renderer/types';

const agentConfigurationMock = vi.hoisted(() => ({
	useAgentConfiguration: vi.fn(),
}));

vi.mock('../../../renderer/hooks/agent', () => ({
	useAgentConfiguration: agentConfigurationMock.useAgentConfiguration,
}));

vi.mock('../../../renderer/components/shared/AgentConfigPanel', () => ({
	AgentConfigPanel: ({ customEnvVars }: { customEnvVars: Record<string, string> }) => (
		<div data-testid="agent-config-panel">
			{Object.entries(customEnvVars).map(([key, value]) => (
				<div key={key}>
					<span>{key}</span>
					<span>{value}</span>
				</div>
			))}
		</div>
	),
}));

vi.mock('../../../renderer/components/ui/Modal', () => ({
	Modal: ({
		title,
		onClose,
		headerIcon,
		children,
		footer,
	}: {
		title: string;
		onClose: () => void;
		headerIcon?: React.ReactNode;
		children: React.ReactNode;
		footer?: React.ReactNode;
	}) => (
		<div role="dialog" aria-label={title}>
			<div>
				{headerIcon}
				<h2>{title}</h2>
				<button type="button" aria-label="Close modal" onClick={onClose}>
					Close
				</button>
			</div>
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
}));

vi.mock('../../../renderer/components/ui', async () => {
	const React = await vi.importActual<typeof import('react')>('react');

	return {
		Modal: ({
			title,
			onClose,
			children,
			footer,
		}: {
			title: string;
			onClose: () => void;
			children: React.ReactNode;
			footer?: React.ReactNode;
		}) => (
			<div role="dialog" aria-label={title}>
				<div>
					<h2>{title}</h2>
					<button type="button" aria-label="Close modal" onClick={onClose}>
						Close
					</button>
				</div>
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
		FormInput: React.forwardRef<
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

const theme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#222222',
		bgActivity: '#333333',
		textMain: '#ffffff',
		textDim: '#999999',
		accent: '#00aaff',
		accentForeground: '#ffffff',
		border: '#444444',
		error: '#ff5555',
		warning: '#ffaa00',
	},
};

const createMockTheme = () => theme;

function createMockAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		id: 'claude-code',
		name: 'Claude Code',
		command: 'claude-code',
		args: [],
		available: true,
		path: '/usr/local/bin/claude-code',
		hidden: false,
		capabilities: {},
		...overrides,
	};
}

function setupDefaultMocks(agents: AgentConfig[] = [createMockAgent()]) {
	const agentConfig = { model: '' };

	agentConfigurationMock.useAgentConfiguration.mockReturnValue({
		isDetecting: false,
		detectedAgents: agents,
		selectedAgent: agents[0]?.id ?? null,
		setSelectedAgent: vi.fn(),
		handleAgentChange: vi.fn(),
		customPath: '',
		setCustomPath: vi.fn(),
		customArgs: '',
		setCustomArgs: vi.fn(),
		customEnvVars: { MAESTRO_SESSION_RESUMED: '1 (when resuming)' },
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
		isConfigExpanded: true,
		toggleConfigExpanded: vi.fn(),
		hasCustomization: true,
		sshRemotes: [],
		sshRemoteConfig: undefined,
		setSshRemoteConfig: vi.fn(),
	});
}

function invokeReactClickHandler(button: HTMLElement) {
	const reactPropsKey = Object.getOwnPropertyNames(button).find((key) =>
		key.startsWith('__reactProps$')
	);
	expect(reactPropsKey).toBeDefined();

	const reactProps = (button as unknown as Record<string, { onClick?: () => void }>)[
		reactPropsKey as string
	];
	expect(reactProps.onClick).toEqual(expect.any(Function));
	reactProps.onClick?.();
}

describe('DeleteGroupChatModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setupDefaultMocks();
	});

	describe('create mode', () => {
		it('should display MAESTRO_SESSION_RESUMED in moderator configuration panel', async () => {
			const onCreate = vi.fn();
			const onClose = vi.fn();

			render(
				<GroupChatModal
					mode="create"
					theme={createMockTheme()}
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
				/>
			);

			// Wait for agent detection and verify dropdown is rendered
			await waitFor(
				() => {
					expect(screen.getByRole('combobox', { name: /select moderator/i })).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			// Verify Claude Code is selected in dropdown
			const dropdown = screen.getByRole('combobox', { name: /select moderator/i });
			expect(dropdown).toHaveValue('claude-code');

			// Click the Customize button to expand config panel
			const customizeButton = screen.getByRole('button', { name: /customize/i });
			fireEvent.click(customizeButton);

			// Wait for config panel to appear and verify MAESTRO_SESSION_RESUMED is displayed
			await waitFor(() => {
				expect(screen.getByText('MAESTRO_SESSION_RESUMED')).toBeInTheDocument();
			});

			// Also verify the value hint is shown
			expect(screen.getByText('1 (when resuming)')).toBeInTheDocument();
		});

		it('should show all available agents in dropdown', async () => {
			// Setup multiple agents
			setupDefaultMocks([
				createMockAgent({ id: 'claude-code', name: 'Claude Code' }),
				createMockAgent({ id: 'codex', name: 'Codex' }),
				createMockAgent({ id: 'opencode', name: 'OpenCode' }),
				createMockAgent({ id: 'factory-droid', name: 'Factory Droid' }),
			]);

			const onCreate = vi.fn();
			const onClose = vi.fn();

			render(
				<GroupChatModal
					mode="create"
					theme={createMockTheme()}
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
				/>
			);

			// Wait for dropdown to be rendered
			await waitFor(
				() => {
					expect(screen.getByRole('combobox', { name: /select moderator/i })).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			// Verify all agents appear as options
			expect(screen.getByRole('option', { name: /Claude Code/i })).toBeInTheDocument();
			expect(screen.getByRole('option', { name: /OpenCode.*Beta/i })).toBeInTheDocument();
			expect(screen.getByRole('option', { name: /Factory Droid.*Beta/i })).toBeInTheDocument();
			expect(screen.getByRole('option', { name: /^Codex$/i })).toBeInTheDocument();
		});
	});

	function renderDeleteModal(
		overrides: Partial<React.ComponentProps<typeof DeleteGroupChatModal>> = {}
	) {
		const props: React.ComponentProps<typeof DeleteGroupChatModal> = {
			theme,
			isOpen: true,
			groupChatName: 'Planning Room',
			onClose: vi.fn(),
			onConfirm: vi.fn(),
			...overrides,
		};

		return {
			...render(<DeleteGroupChatModal {...props} />),
			props,
		};
	}

	it('does not render when closed', () => {
		renderDeleteModal({ isOpen: false });

		expect(screen.queryByRole('dialog', { name: 'Delete Group Chat' })).not.toBeInTheDocument();
	});

	it('renders permanent-delete warning and closes from cancel and header controls', () => {
		const { props, unmount } = renderDeleteModal();

		expect(screen.getByRole('dialog', { name: 'Delete Group Chat' })).toBeInTheDocument();
		expect(screen.getByText('"Planning Room"')).toBeInTheDocument();
		expect(screen.getByText(/permanently delete the group chat/i)).toBeInTheDocument();
		expect(screen.getByText(/Participant sessions will not be affected/i)).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(props.onClose).toHaveBeenCalledTimes(1);
		expect(props.onConfirm).not.toHaveBeenCalled();
		unmount();

		const second = renderDeleteModal();
		fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));
		expect(second.props.onClose).toHaveBeenCalledTimes(1);
		expect(second.props.onConfirm).not.toHaveBeenCalled();
	});

	it('confirms deletion and then closes', () => {
		const { props } = renderDeleteModal();

		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

		expect(props.onConfirm).toHaveBeenCalledTimes(1);
		expect(props.onClose).toHaveBeenCalledTimes(1);
	});
});

describe('RenameGroupChatModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function renderRenameModal(
		overrides: Partial<React.ComponentProps<typeof RenameGroupChatModal>> = {}
	) {
		const props: React.ComponentProps<typeof RenameGroupChatModal> = {
			theme,
			isOpen: true,
			currentName: 'Planning Room',
			onClose: vi.fn(),
			onRename: vi.fn(),
			...overrides,
		};

		return {
			...render(<RenameGroupChatModal {...props} />),
			props,
		};
	}

	it('does not render when closed', () => {
		renderRenameModal({ isOpen: false });

		expect(screen.queryByRole('dialog', { name: 'Rename Group Chat' })).not.toBeInTheDocument();
	});

	it('renders the current name, resets on reopen with a new name, and closes from cancel', async () => {
		const { props, rerender } = renderRenameModal();

		expect(screen.getByRole('dialog', { name: 'Rename Group Chat' })).toBeInTheDocument();
		expect(screen.getByLabelText('Chat Name')).toHaveValue('Planning Room');

		fireEvent.change(screen.getByLabelText('Chat Name'), {
			target: { value: 'Draft Name' },
		});
		expect(screen.getByLabelText('Chat Name')).toHaveValue('Draft Name');

		rerender(<RenameGroupChatModal {...props} isOpen={false} currentName="Execution Room" />);
		expect(screen.queryByRole('dialog', { name: 'Rename Group Chat' })).not.toBeInTheDocument();

		rerender(<RenameGroupChatModal {...props} currentName="Execution Room" />);
		await waitFor(() => {
			expect(screen.getByLabelText('Chat Name')).toHaveValue('Execution Room');
		});

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(props.onClose).toHaveBeenCalledTimes(1);
	});

	it('keeps rename disabled for blank or unchanged names and guards direct submission', () => {
		const { props } = renderRenameModal();

		const renameButton = screen.getByRole('button', { name: 'Rename' });
		expect(renameButton).toBeDisabled();
		invokeReactClickHandler(renameButton);
		expect(props.onRename).not.toHaveBeenCalled();
		expect(props.onClose).not.toHaveBeenCalled();

		fireEvent.change(screen.getByLabelText('Chat Name'), { target: { value: '   ' } });
		expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
		invokeReactClickHandler(screen.getByRole('button', { name: 'Rename' }));
		expect(props.onRename).not.toHaveBeenCalled();
		expect(props.onClose).not.toHaveBeenCalled();
	});

	it('renames with trimmed text from click and Enter submission', async () => {
		const { props, unmount } = renderRenameModal();

		fireEvent.change(screen.getByLabelText('Chat Name'), {
			target: { value: '  Launch Room  ' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

		expect(props.onRename).toHaveBeenCalledWith('Launch Room');
		expect(props.onClose).toHaveBeenCalledTimes(1);
		unmount();

		const second = renderRenameModal();
		fireEvent.change(screen.getByLabelText('Chat Name'), {
			target: { value: 'Review Room' },
		});
		fireEvent.keyDown(screen.getByLabelText('Chat Name'), { key: 'Enter' });

		await waitFor(() => {
			expect(second.props.onRename).toHaveBeenCalledWith('Review Room');
			expect(second.props.onClose).toHaveBeenCalledTimes(1);
		});
	});
});
