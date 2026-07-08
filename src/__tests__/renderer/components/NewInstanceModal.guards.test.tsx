import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EditAgentModal, NewInstanceModal } from '../../../renderer/components/NewInstanceModal';
import type { AgentConfig, Session, Theme } from '../../../renderer/types';

vi.mock('../../../renderer/components/ui/Modal', () => ({
	Modal: ({ title, customHeader, children, footer }: any) => (
		<div role="dialog" aria-label={title}>
			{customHeader}
			{children}
			{footer}
		</div>
	),
	ModalFooter: ({ onCancel, onConfirm, confirmLabel, confirmDisabled }: any) => (
		<div>
			<button type="button" onClick={onCancel}>
				Cancel
			</button>
			<button type="button" aria-disabled={confirmDisabled ? 'true' : 'false'} onClick={onConfirm}>
				{confirmLabel}
			</button>
		</div>
	),
}));

vi.mock('../../../renderer/components/shared/AgentConfigPanel', () => ({
	AgentConfigPanel: ({ agent, onRefreshModels, onConfigBlur }: any) => (
		<div data-testid={`mock-agent-config-${agent.id}`}>
			<button type="button" onClick={onRefreshModels}>
				Mock refresh models
			</button>
			<button type="button" onClick={() => onConfigBlur?.('providerPath', '/mock/provider')}>
				Mock persist config
			</button>
		</div>
	),
}));

const theme: Theme = {
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
		accentForeground: '#ffffff',
		border: '#333355',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
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

describe('NewInstanceModal guarded callbacks', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.fs.homeDir).mockResolvedValue('/home/testuser');
		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue(null);
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([createAgentConfig()]);
		vi.mocked(window.maestro.agents.getAllCustomPaths).mockResolvedValue({});
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue([]);
		vi.mocked(window.maestro.agents.setConfig).mockResolvedValue(undefined);
		vi.mocked(window.maestro.agents.refresh).mockResolvedValue({
			agents: [createAgentConfig()],
			debugInfo: null,
		});
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [],
		});
	});

	it('ignores direct create confirmation when required fields are blank or invalid', async () => {
		const onCreate = vi.fn();
		const duplicateSession = createSession({ id: 'existing', name: 'Existing Agent' });

		render(
			<NewInstanceModal
				isOpen
				onClose={vi.fn()}
				onCreate={onCreate}
				theme={theme}
				existingSessions={[duplicateSession]}
			/>
		);

		await screen.findByLabelText('Agent Name');
		fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));
		expect(onCreate).not.toHaveBeenCalled();

		fireEvent.change(screen.getByLabelText('Agent Name'), {
			target: { value: 'Existing Agent' },
		});
		fireEvent.change(screen.getByLabelText('Working Directory'), {
			target: { value: '/different/project' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));

		expect(onCreate).not.toHaveBeenCalled();
	});

	it('skips create-side model refresh when the expanded agent does not support models', async () => {
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([
			createAgentConfig({
				id: 'factory-droid',
				name: 'Factory Droid',
				available: true,
			}),
		]);
		const onCreate = vi.fn();

		render(
			<NewInstanceModal
				isOpen
				onClose={vi.fn()}
				onCreate={onCreate}
				theme={theme}
				existingSessions={[]}
			/>
		);

		fireEvent.click(await screen.findByText('Factory Droid'));
		fireEvent.click(screen.getByRole('button', { name: 'Mock refresh models' }));
		fireEvent.click(screen.getByRole('button', { name: 'Mock persist config' }));

		expect(window.maestro.agents.getModels).not.toHaveBeenCalled();
		await waitFor(() => {
			expect(window.maestro.agents.setConfig).toHaveBeenCalledWith('factory-droid', {
				providerPath: '/mock/provider',
			});
		});
	});

	it('persists config using an empty fallback when no agent config has loaded', async () => {
		const onCreate = vi.fn();
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue(undefined as any);

		render(
			<NewInstanceModal
				isOpen
				onClose={vi.fn()}
				onCreate={onCreate}
				theme={theme}
				existingSessions={[]}
			/>
		);

		fireEvent.click(await screen.findByText('Claude Code'));
		fireEvent.click(await screen.findByRole('button', { name: 'Mock persist config' }));

		await waitFor(() => {
			expect(window.maestro.agents.setConfig).toHaveBeenCalledWith('claude-code', {
				providerPath: '/mock/provider',
			});
		});
	});

	it('ignores direct edit confirmation when the edited name is blank or duplicated', async () => {
		const onSave = vi.fn();

		render(
			<EditAgentModal
				isOpen
				onClose={vi.fn()}
				onSave={onSave}
				theme={theme}
				session={createSession()}
				existingSessions={[createSession({ id: 'other', name: 'Taken Agent' })]}
			/>
		);

		const nameInput = await screen.findByLabelText('Agent Name');
		fireEvent.change(nameInput, { target: { value: '   ' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
		expect(onSave).not.toHaveBeenCalled();

		fireEvent.change(nameInput, { target: { value: 'Taken Agent' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
		expect(onSave).not.toHaveBeenCalled();
	});

	it('skips edit-side model refresh when the loaded agent does not support models', async () => {
		const onSave = vi.fn();

		render(
			<EditAgentModal
				isOpen
				onClose={vi.fn()}
				onSave={onSave}
				theme={theme}
				session={createSession()}
				existingSessions={[]}
			/>
		);

		await screen.findByTestId('mock-agent-config-claude-code');
		fireEvent.click(screen.getByRole('button', { name: 'Mock refresh models' }));

		expect(window.maestro.agents.getModels).not.toHaveBeenCalled();
	});
});
