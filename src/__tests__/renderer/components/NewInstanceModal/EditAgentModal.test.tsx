/**
 * @fileoverview Tests for EditAgentModal component
 * Tests: rendering, form population, validation, save handling,
 * provider switching, SSH config, keyboard shortcuts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EditAgentModal } from '../../../../renderer/components/NewInstanceModal/EditAgentModal';
import type { Theme, Session, AgentConfig } from '../../../../renderer/types';

// lucide-react icons are mocked globally in src/__tests__/setup.ts using a Proxy

// Mock layer stack context
const mockRegisterLayer = vi.fn(() => 'layer-edit-agent-123');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
		getTopLayer: () => undefined,
		closeTopLayer: vi.fn().mockResolvedValue(true),
		getLayers: () => [],
		hasOpenLayers: () => false,
		hasOpenModal: () => false,
	}),
}));

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

const createSession = (overrides: Partial<Session> = {}): Session =>
	({
		id: 'session-123',
		name: 'My Agent',
		toolType: 'claude-code',
		projectRoot: '/home/user/project',
		cwd: '/home/user/project',
		nudgeMessage: 'Be concise',
		status: 'ready',
		tabs: [],
		activeTabId: null,
		customPath: '/custom/claude',
		customArgs: '--verbose',
		customEnvVars: { API_KEY: 'test-key' },
		customModel: 'claude-sonnet',
		customContextWindow: 100000,
		...overrides,
	}) as Session;

describe('EditAgentModal', () => {
	let theme: Theme;
	let onClose: ReturnType<typeof vi.fn>;
	let onSave: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		theme = createTheme();
		onClose = vi.fn();
		onSave = vi.fn();

		mockRegisterLayer.mockClear().mockReturnValue('layer-edit-agent-123');
		mockUnregisterLayer.mockClear();
		mockUpdateLayerHandler.mockClear();

		vi.mocked(window.maestro.agents.detect).mockResolvedValue([
			{
				id: 'claude-code',
				name: 'Claude Code',
				available: true,
				path: '/usr/local/bin/claude',
				binaryName: 'claude',
				hidden: false,
			} as AgentConfig,
		]);
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
			model: 'claude-sonnet',
			contextWindow: 200000,
		});
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['claude-sonnet', 'claude-opus']);
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [],
		});
		vi.mocked(window.maestro.fs.stat).mockResolvedValue({
			isDirectory: true,
			isFile: false,
			size: 0,
			mtimeMs: 0,
		});
	});

	it('should render null when isOpen is false', () => {
		const { container } = render(
			<EditAgentModal
				isOpen={false}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession()}
				existingSessions={[]}
			/>
		);

		expect(container.innerHTML).toBe('');
	});

	it('should render null when session is null', () => {
		const { container } = render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={null}
				existingSessions={[]}
			/>
		);

		expect(container.innerHTML).toBe('');
	});

	it('should populate form fields from session on open', async () => {
		const session = createSession({ name: 'Test Agent', nudgeMessage: 'Be helpful' });

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
			const nameInput = screen.getByDisplayValue('Test Agent');
			expect(nameInput).toBeInTheDocument();
		});
	});

	it('should show session name in modal title', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({ name: 'My Special Agent' })}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			expect(screen.getAllByText(/Edit Agent: My Special Agent/).length).toBeGreaterThanOrEqual(1);
		});
	});

	it('should show read-only working directory', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({ projectRoot: '/home/user/my-project' })}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			expect(screen.getByText('/home/user/my-project')).toBeInTheDocument();
			expect(
				screen.getByText(
					'Directory cannot be changed. Create a new agent for a different directory.'
				)
			).toBeInTheDocument();
		});
	});

	it('should show copy session ID button with truncated ID', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({ id: 'abcdefgh-1234-5678' })}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			expect(screen.getByText('abcdefgh')).toBeInTheDocument();
		});
	});

	it('should render provider dropdown with supported agents', async () => {
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

		await waitFor(() => {
			const select = screen.getByRole('combobox');
			expect(select).toBeInTheDocument();
		});
	});

	it('should show provider change warning when provider is changed', async () => {
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

		await waitFor(() => {
			const select = screen.getByRole('combobox');
			expect(select).toBeInTheDocument();
		});

		// Change provider
		fireEvent.change(screen.getByRole('combobox'), { target: { value: 'codex' } });

		await waitFor(() => {
			expect(
				screen.getByText(/Changing the provider will clear your session list/)
			).toBeInTheDocument();
		});
	});

	it('should call onSave with correct parameters when save button is clicked', async () => {
		const session = createSession({
			id: 'test-id',
			name: 'Original Name',
			nudgeMessage: 'Be helpful',
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

		await waitFor(() => {
			expect(screen.getByDisplayValue('Original Name')).toBeInTheDocument();
		});

		// Click Save Changes
		fireEvent.click(screen.getByText('Save Changes'));

		expect(onSave).toHaveBeenCalledWith(
			'test-id',
			'Original Name',
			undefined, // toolType not changed
			'Be helpful',
			undefined, // newSessionMessage
			'/custom/claude',
			'--verbose',
			{ API_KEY: 'test-key' },
			expect.anything(), // model
			expect.anything(), // contextWindow
			expect.objectContaining({ enabled: false }) // SSH disabled
		);
		expect(onClose).toHaveBeenCalled();
	});

	it('should trigger save on Cmd+Enter when form is valid', async () => {
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

		await waitFor(() => {
			expect(screen.getByDisplayValue('My Agent')).toBeInTheDocument();
		});

		fireEvent.keyDown(window, { key: 'Enter', metaKey: true });

		expect(onSave).toHaveBeenCalled();
	});

	it('should trigger save on Cmd+S when form is valid', async () => {
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

		await waitFor(() => {
			expect(screen.getByDisplayValue('My Agent')).toBeInTheDocument();
		});

		fireEvent.keyDown(window, { key: 's', metaKey: true });

		expect(onSave).toHaveBeenCalled();
	});

	it('should not trigger save on Cmd+Enter when name is empty', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({ name: '' })}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		fireEvent.keyDown(window, { key: 'Enter', metaKey: true });

		expect(onSave).not.toHaveBeenCalled();
	});

	it('should show Save Changes and Cancel buttons', async () => {
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

		await waitFor(() => {
			expect(screen.getByText('Save Changes')).toBeInTheDocument();
			expect(screen.getByText('Cancel')).toBeInTheDocument();
		});
	});

	it('should call onClose when Cancel is clicked', async () => {
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

		await waitFor(() => {
			expect(screen.getByText('Cancel')).toBeInTheDocument();
		});

		fireEvent.click(screen.getByText('Cancel'));
		expect(onClose).toHaveBeenCalled();
	});

	it('should show close button with correct aria-label', async () => {
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

		await waitFor(() => {
			expect(screen.getByLabelText('Close modal')).toBeInTheDocument();
		});
	});

	it('should show NudgeMessageField with session nudge message', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({ nudgeMessage: 'Test nudge' })}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			const textarea = screen.getByPlaceholderText(
				'Instructions appended to every message you send...'
			);
			expect(textarea).toHaveValue('Test nudge');
		});
	});

	it('should show NewSessionMessageField with session new session message', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({ newSessionMessage: 'Init instructions' })}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			const textarea = screen.getByPlaceholderText(
				'Instructions sent with the first message of every new session...'
			);
			expect(textarea).toHaveValue('Init instructions');
		});
	});

	it('should set workingDirOverride from projectRoot when saving SSH session without explicit override (regression: SSH terminal cwd)', async () => {
		// Regression test: when an SSH session has no explicit workingDirOverride
		// (e.g., created before the fix), saving it should populate workingDirOverride
		// from session.projectRoot so SSH terminals cd to the correct remote directory.
		const sshSession = createSession({
			projectRoot: '/home/devuser/my-project',
			cwd: '/home/devuser/my-project',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
				// No workingDirOverride — this is the regression scenario
			},
		});

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

		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={sshSession}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			expect(screen.getByDisplayValue('My Agent')).toBeInTheDocument();
		});

		fireEvent.click(screen.getByText('Save Changes'));

		// workingDirOverride should be populated from projectRoot
		expect(onSave).toHaveBeenCalledWith(
			expect.any(String), // sessionId
			expect.any(String), // name
			undefined, // toolType not changed
			'Be concise', // nudgeMessage
			undefined, // newSessionMessage
			'/custom/claude', // customPath
			'--verbose', // customArgs
			{ API_KEY: 'test-key' }, // customEnvVars
			'claude-sonnet', // model
			100000, // contextWindow
			expect.objectContaining({
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/home/devuser/my-project',
			})
		);
	});

	it('should preserve explicit workingDirOverride when saving SSH session (regression: SSH terminal cwd)', async () => {
		// When a session already has an explicit workingDirOverride, saving should keep it
		// (not overwrite it with projectRoot).
		const sshSession = createSession({
			projectRoot: '/home/devuser/project',
			cwd: '/home/devuser/project',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/explicit/remote/path',
			},
		});

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

		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={sshSession}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			expect(screen.getByDisplayValue('My Agent')).toBeInTheDocument();
		});

		fireEvent.click(screen.getByText('Save Changes'));

		// Explicit workingDirOverride should be preserved, not replaced by projectRoot
		expect(onSave).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(String),
			undefined,
			'Be concise', // nudgeMessage
			undefined, // newSessionMessage
			'/custom/claude', // customPath
			'--verbose', // customArgs
			{ API_KEY: 'test-key' }, // customEnvVars
			'claude-sonnet', // model
			100000, // contextWindow
			expect.objectContaining({
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/explicit/remote/path',
			})
		);
	});

	it('should render SSH remote selector when remotes exist', async () => {
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [
				{
					id: 'remote-1',
					name: 'Dev Server',
					host: 'dev.example.com',
					user: 'admin',
					port: 22,
				},
			],
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

		// SSH selector should appear after SSH configs load
		await waitFor(() => {
			expect(screen.getByText('SSH Remote Execution')).toBeInTheDocument();
		});
	});
});
