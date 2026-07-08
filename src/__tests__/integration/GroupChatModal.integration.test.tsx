import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GroupChatModal } from '../../renderer/components/GroupChatModal';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../renderer/types';
import type { GroupChat } from '../../shared/group-chat-types';

const hookState = vi.hoisted(() => ({
	availableModels: [] as string[],
	detectedAgents: [] as Array<{ id: string; name: string; available: boolean }>,
	initialAgentConfig: {} as Record<string, unknown>,
	initialCustomArgs: '',
	initialCustomEnvVars: {} as Record<string, string>,
	initialCustomPath: '',
	initialEnableMaestroP: false,
	initialExpanded: false,
	initialMaestroPMode: 'dynamic' as 'interactive' | 'dynamic',
	initialMaestroPPath: '',
	initialSelectedAgent: null as string | null,
	initialSshRemoteConfig: undefined as unknown,
	isDetecting: false,
	loadingModels: false,
	refreshAgent: vi.fn(),
	refreshingAgent: false,
	refreshModels: vi.fn(),
	saveAgentConfig: vi.fn(),
	sshRemotes: [] as Array<{ id: string; name: string }>,
}));

vi.mock('../../renderer/hooks/agent', async () => {
	const React = await import('react');

	return {
		useAgentConfiguration: () => {
			const [selectedAgent, setSelectedAgent] = React.useState<string | null>(
				hookState.initialSelectedAgent
			);
			const [customPath, setCustomPath] = React.useState(hookState.initialCustomPath);
			const [customArgs, setCustomArgs] = React.useState(hookState.initialCustomArgs);
			const [customEnvVars, setCustomEnvVars] = React.useState(hookState.initialCustomEnvVars);
			const [agentConfig, setAgentConfig] = React.useState(hookState.initialAgentConfig);
			const [enableMaestroP, setEnableMaestroP] = React.useState(hookState.initialEnableMaestroP);
			const [maestroPMode, setMaestroPMode] = React.useState(hookState.initialMaestroPMode);
			const [maestroPPath, setMaestroPPath] = React.useState(hookState.initialMaestroPPath);
			const [isConfigExpanded, setIsConfigExpanded] = React.useState(hookState.initialExpanded);
			const [sshRemoteConfig, setSshRemoteConfig] = React.useState(
				hookState.initialSshRemoteConfig
			);
			const agentConfigRef = React.useRef(agentConfig);
			agentConfigRef.current = agentConfig;
			const hasCustomization = Boolean(
				customPath ||
				customArgs ||
				Object.keys(customEnvVars).length > 0 ||
				agentConfig.model ||
				sshRemoteConfig ||
				enableMaestroP
			);

			return {
				agentConfig,
				agentConfigRef,
				availableModels: hookState.availableModels,
				customArgs,
				customEnvVars,
				customPath,
				detectedAgents: hookState.detectedAgents,
				dynamicOptions: {},
				enableMaestroP,
				handleAgentChange: setSelectedAgent,
				hasCustomization,
				isConfigExpanded,
				isDetecting: hookState.isDetecting,
				loadSshRemotes: true,
				loadingDynamicOptions: false,
				loadingModels: hookState.loadingModels,
				maestroPMode,
				maestroPPath,
				refreshAgent: hookState.refreshAgent,
				refreshingAgent: hookState.refreshingAgent,
				refreshModels: hookState.refreshModels,
				saveAgentConfig: hookState.saveAgentConfig,
				selectedAgent,
				setAgentConfig,
				setCustomArgs,
				setCustomEnvVars,
				setCustomPath,
				setEnableMaestroP,
				setMaestroPMode,
				setMaestroPPath,
				setSelectedAgent,
				setSshRemoteConfig,
				sshRemoteConfig,
				sshRemotes: hookState.sshRemotes,
				toggleConfigExpanded: () => setIsConfigExpanded((expanded) => !expanded),
			};
		},
	};
});

vi.mock('../../renderer/components/shared/AgentConfigPanel', async () => {
	const React = await import('react');

	return {
		AgentConfigPanel: (props: {
			onConfigBlur: () => Promise<void>;
			onConfigChange: (key: string, value: unknown) => void;
			onCustomArgsChange: (value: string) => void;
			onCustomArgsClear: () => void;
			onCustomPathChange: (value: string) => void;
			onCustomPathClear: () => void;
			onEnvVarAdd: () => void;
			onEnvVarKeyChange: (oldKey: string, newKey: string, value: string) => void;
			onEnvVarRemove: (key: string) => void;
			onEnvVarValueChange: (key: string, value: string) => void;
		}) =>
			React.createElement(
				'div',
				{ 'data-testid': 'agent-config-panel' },
				React.createElement(
					'button',
					{ type: 'button', onClick: () => props.onCustomPathChange('/opt/codex') },
					'Set path'
				),
				React.createElement(
					'button',
					{ type: 'button', onClick: props.onCustomPathClear },
					'Clear path'
				),
				React.createElement(
					'button',
					{ type: 'button', onClick: () => props.onCustomArgsChange('--yolo') },
					'Set args'
				),
				React.createElement(
					'button',
					{ type: 'button', onClick: props.onCustomArgsClear },
					'Clear args'
				),
				React.createElement(
					'button',
					{
						type: 'button',
						onClick: () => props.onEnvVarValueChange('TOKEN', 'secret'),
					},
					'Set env'
				),
				React.createElement(
					'button',
					{
						type: 'button',
						onClick: () => props.onEnvVarKeyChange('OLD_ENV', 'RENAMED_ENV', '2'),
					},
					'Rename env'
				),
				React.createElement(
					'button',
					{ type: 'button', onClick: () => props.onEnvVarRemove('RENAMED_ENV') },
					'Remove renamed env'
				),
				React.createElement('button', { type: 'button', onClick: props.onEnvVarAdd }, 'Add env'),
				React.createElement(
					'button',
					{ type: 'button', onClick: () => props.onConfigChange('model', 'gpt-5') },
					'Set model'
				),
				React.createElement(
					'button',
					{ type: 'button', onClick: () => void props.onConfigBlur() },
					'Blur config'
				)
			),
	};
});

vi.mock('../../renderer/components/shared/SshRemoteSelector', async () => {
	const React = await import('react');

	return {
		SshRemoteSelector: (props: {
			onSshRemoteConfigChange: (config: { enabled: boolean; remoteId: string }) => void;
		}) =>
			React.createElement(
				'button',
				{
					type: 'button',
					onClick: () => props.onSshRemoteConfigChange({ enabled: true, remoteId: 'remote-1' }),
				},
				'Use remote'
			),
	};
});

const theme: Theme = {
	id: 'test',
	name: 'Test',
	mode: 'dark',
	colors: {
		accent: '#10a37f',
		accentDim: '#10a37f20',
		accentForeground: '#000000',
		accentText: '#ffffff',
		bgActivity: '#1f2937',
		bgMain: '#111827',
		bgSidebar: '#0f172a',
		border: '#334155',
		error: '#ef4444',
		success: '#22c55e',
		textDim: '#94a3b8',
		textMain: '#f8fafc',
		warning: '#f59e0b',
	},
};

describe('GroupChatModal integration', () => {
	beforeEach(() => {
		hookState.availableModels = [];
		hookState.detectedAgents = [
			{ id: 'claude-code', name: 'Claude Code', available: true },
			{ id: 'codex', name: 'Codex', available: true },
		];
		hookState.initialAgentConfig = {};
		hookState.initialCustomArgs = '';
		hookState.initialCustomEnvVars = {};
		hookState.initialCustomPath = '';
		hookState.initialEnableMaestroP = false;
		hookState.initialExpanded = false;
		hookState.initialMaestroPMode = 'dynamic';
		hookState.initialMaestroPPath = '';
		hookState.initialSelectedAgent = null;
		hookState.initialSshRemoteConfig = undefined;
		hookState.isDetecting = false;
		hookState.loadingModels = false;
		hookState.refreshAgent.mockClear();
		hookState.refreshingAgent = false;
		hookState.refreshModels.mockClear();
		hookState.saveAgentConfig.mockClear();
		hookState.sshRemotes = [];
	});

	afterEach(() => {
		cleanup();
	});

	it('creates a group chat with selected moderator customization and SSH config', async () => {
		hookState.sshRemotes = [{ id: 'remote-1', name: 'Remote One' }];
		const onClose = vi.fn();
		const onCreate = vi.fn();

		renderModal(
			<GroupChatModal mode="create" theme={theme} isOpen onClose={onClose} onCreate={onCreate} />
		);

		await waitFor(() => {
			expect(screen.getByLabelText('Select moderator agent')).toHaveValue('claude-code');
		});
		fireEvent.change(screen.getByLabelText('Select moderator agent'), {
			target: { value: 'codex' },
		});
		fireEvent.click(screen.getByRole('button', { name: /customize/i }));
		fireEvent.click(screen.getByRole('button', { name: 'Set path' }));
		fireEvent.click(screen.getByRole('button', { name: 'Set args' }));
		fireEvent.click(screen.getByRole('button', { name: 'Set env' }));
		fireEvent.click(screen.getByRole('button', { name: 'Set model' }));
		fireEvent.click(screen.getByRole('button', { name: 'Use remote' }));
		fireEvent.change(screen.getByLabelText('Chat Name'), {
			target: { value: '  Coverage Crew  ' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Create' }));

		expect(onCreate).toHaveBeenCalledWith('Coverage Crew', 'codex', {
			customArgs: '--yolo',
			customEnvVars: { TOKEN: 'secret' },
			customModel: 'gpt-5',
			customPath: '/opt/codex',
			sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('creates a group chat without moderator config when customization is empty', async () => {
		const onClose = vi.fn();
		const onCreate = vi.fn();

		renderModal(
			<GroupChatModal mode="create" theme={theme} isOpen onClose={onClose} onCreate={onCreate} />
		);

		await waitFor(() => {
			expect(screen.getByLabelText('Select moderator agent')).toHaveValue('claude-code');
		});
		fireEvent.change(screen.getByLabelText('Chat Name'), {
			target: { value: 'Plain Crew' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Create' }));

		expect(onCreate).toHaveBeenCalledWith('Plain Crew', 'claude-code', undefined);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('falls back to the first detected agent when none match supported agent tiles', async () => {
		hookState.detectedAgents = [{ id: 'unknown-agent', name: 'Unknown Agent', available: true }];

		renderModal(
			<GroupChatModal mode="create" theme={theme} isOpen onClose={vi.fn()} onCreate={vi.fn()} />
		);

		await waitFor(() => {
			expect(screen.getByText(/No agents available/)).toBeInTheDocument();
		});
		expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
	});

	it('edits an existing group chat and warns when the moderator changes', async () => {
		const onClose = vi.fn();
		const onSave = vi.fn();
		const groupChat = makeGroupChat();
		hookState.initialSelectedAgent = 'claude-code';

		renderModal(
			<GroupChatModal
				mode="edit"
				theme={theme}
				isOpen
				onClose={onClose}
				onSave={onSave}
				groupChat={groupChat}
			/>
		);

		await waitFor(() => {
			expect(screen.getByLabelText('Chat Name')).toHaveValue('Existing Chat');
		});
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

		fireEvent.change(screen.getByLabelText('Select moderator agent'), {
			target: { value: 'codex' },
		});
		expect(screen.getByText(/Changing the moderator agent/)).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText('Chat Name'), {
			target: { value: 'Edited Chat' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(onSave).toHaveBeenCalledWith('group-1', 'Edited Chat', 'codex', {
			customArgs: '--old',
			customEnvVars: { OLD_ENV: '1' },
			customPath: '/old/claude',
			sshRemoteConfig: { enabled: true, remoteId: 'old-remote' },
		});
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('saves edit-mode config changes after env mutation, clears, add, and blur handlers', async () => {
		const onClose = vi.fn();
		const onSave = vi.fn();
		hookState.initialExpanded = true;
		hookState.initialSelectedAgent = 'claude-code';
		const groupChat = makeGroupChat({
			moderatorConfig: {
				customArgs: '--old',
				customEnvVars: { OLD_ENV: '1', NEW_VAR: 'occupied' },
				customPath: '/old/claude',
			},
		});

		renderModal(
			<GroupChatModal
				mode="edit"
				theme={theme}
				isOpen
				onClose={onClose}
				onSave={onSave}
				groupChat={groupChat}
			/>
		);

		await waitFor(() => {
			expect(screen.getByTestId('agent-config-panel')).toBeInTheDocument();
		});

		fireEvent.click(screen.getByRole('button', { name: 'Clear path' }));
		fireEvent.click(screen.getByRole('button', { name: 'Clear args' }));
		fireEvent.click(screen.getByRole('button', { name: 'Rename env' }));
		fireEvent.click(screen.getByRole('button', { name: 'Remove renamed env' }));
		fireEvent.click(screen.getByRole('button', { name: 'Add env' }));
		fireEvent.click(screen.getByRole('button', { name: 'Set model' }));
		fireEvent.click(screen.getByRole('button', { name: 'Blur config' }));
		await waitFor(() => {
			expect(hookState.saveAgentConfig).toHaveBeenCalledWith('claude-code');
		});

		fireEvent.change(screen.getByLabelText('Chat Name'), {
			target: { value: 'Config Updated' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(onSave).toHaveBeenCalledWith(
			'group-1',
			'Config Updated',
			'claude-code',
			expect.objectContaining({
				customEnvVars: { NEW_VAR: 'occupied', NEW_VAR_1: '' },
				customModel: 'gpt-5',
			})
		);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('returns null when an edit target disappears after modal state is populated', async () => {
		hookState.initialSelectedAgent = 'claude-code';
		const { rerender } = renderModal(
			<GroupChatModal
				mode="edit"
				theme={theme}
				isOpen
				onClose={vi.fn()}
				onSave={vi.fn()}
				groupChat={makeGroupChat()}
			/>
		);

		await waitFor(() => {
			expect(screen.getByLabelText('Chat Name')).toHaveValue('Existing Chat');
		});

		rerender(
			<LayerStackProvider>
				<GroupChatModal
					mode="edit"
					theme={theme}
					isOpen
					onClose={vi.fn()}
					onSave={vi.fn()}
					groupChat={null}
				/>
			</LayerStackProvider>
		);

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});

	it('handles closed, missing edit target, detecting, and no-agent states', () => {
		const { rerender } = renderModal(
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
			<LayerStackProvider>
				<GroupChatModal
					mode="edit"
					theme={theme}
					isOpen
					onClose={vi.fn()}
					onSave={vi.fn()}
					groupChat={null}
				/>
			</LayerStackProvider>
		);
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

		hookState.isDetecting = true;
		rerender(
			<LayerStackProvider>
				<GroupChatModal mode="create" theme={theme} isOpen onClose={vi.fn()} onCreate={vi.fn()} />
			</LayerStackProvider>
		);
		expect(screen.getByText('Detecting agents...')).toBeInTheDocument();

		hookState.isDetecting = false;
		hookState.detectedAgents = [];
		rerender(
			<LayerStackProvider>
				<GroupChatModal mode="create" theme={theme} isOpen onClose={vi.fn()} onCreate={vi.fn()} />
			</LayerStackProvider>
		);
		expect(screen.getByText(/No agents available/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
	});
});

function renderModal(ui: React.ReactElement) {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
}

function makeGroupChat(overrides: Partial<GroupChat> = {}): GroupChat {
	return {
		id: 'group-1',
		name: 'Existing Chat',
		createdAt: Date.parse('2026-05-25T12:00:00.000Z'),
		updatedAt: Date.parse('2026-05-25T12:10:00.000Z'),
		moderatorAgentId: 'claude-code',
		moderatorSessionId: 'group-chat-group-1-moderator',
		moderatorConfig: {
			customArgs: '--old',
			customEnvVars: { OLD_ENV: '1' },
			customPath: '/old/claude',
			sshRemoteConfig: { enabled: true, remoteId: 'old-remote' },
		},
		participants: [],
		logPath: '/tmp/group-chat.log',
		imagesDir: '/tmp/group-chat-images',
		...overrides,
	};
}
