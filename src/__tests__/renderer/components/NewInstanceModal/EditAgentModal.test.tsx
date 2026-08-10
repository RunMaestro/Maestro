/**
 * @fileoverview Tests for EditAgentModal component
 * Tests: rendering, form population, validation, save handling,
 * provider switching, SSH config, keyboard shortcuts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EditAgentModal } from '../../../../renderer/components/NewInstanceModal/EditAgentModal';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
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
			const providerSelect = screen.getByDisplayValue('Claude Code');
			expect(providerSelect).toBeInTheDocument();
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

		const providerSelect = await screen.findByDisplayValue('Claude Code');

		// Change provider
		fireEvent.change(providerSelect, { target: { value: 'codex' } });

		await waitFor(() => {
			expect(
				screen.getByText(/Changing the provider will clear your session list/)
			).toBeInTheDocument();
		});
	});

	// Effort is per-session (like model), but the panel used to render it straight
	// from the agent-level config: an agent whose customEffort was 'max' displayed
	// the agent-level 'high' while every new tab still spawned at max.
	describe('effort (per-session)', () => {
		const agentWithEffort = {
			id: 'claude-code',
			name: 'Claude Code',
			available: true,
			path: '/usr/local/bin/claude',
			binaryName: 'claude',
			hidden: false,
			configOptions: [
				{ key: 'model', type: 'text', label: 'Model', default: '' },
				{
					key: 'effort',
					type: 'select',
					label: 'Effort',
					options: ['', 'low', 'high', 'max'],
					default: '',
				},
				{ key: 'yoloMode', type: 'checkbox', label: 'YOLO Mode', default: false },
			],
		} as unknown as AgentConfig;

		beforeEach(() => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([agentWithEffort]);
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
				model: 'claude-sonnet',
				contextWindow: 200000,
				effort: 'high',
				yoloMode: false,
			});
			vi.mocked(window.maestro.agents.setConfig).mockResolvedValue(true);
		});

		it("shows the agent's own effort override, not the agent-level default", async () => {
			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={createSession({ customEffort: 'max' })}
					existingSessions={[]}
				/>
			);

			// 'max' (session override), not 'high' (agent-level config)
			expect(await screen.findByDisplayValue('max')).toBeInTheDocument();

			fireEvent.click(screen.getByText('Save Changes'));

			expect(onSave).toHaveBeenCalledWith(
				expect.any(String),
				expect.any(String),
				undefined,
				expect.anything(),
				undefined,
				'/custom/claude',
				'--verbose',
				{ API_KEY: 'test-key' },
				'claude-sonnet',
				'max', // effort round-trips as a per-session override
				100000,
				expect.anything(),
				undefined,
				undefined,
				undefined,
				true,
				true,
				undefined, // additionalDirectories
				undefined // contextWindowSource: the window was not touched, so no
				// provenance is recorded and P1 precedence stands (finding AD1)
			);
		});

		it('saves an edited effort onto the session instead of the shared agent config', async () => {
			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={createSession({ customEffort: 'max' })}
					existingSessions={[]}
				/>
			);

			const effortSelect = await screen.findByDisplayValue('max');
			fireEvent.change(effortSelect, { target: { value: 'low' } });
			fireEvent.click(screen.getByText('Save Changes'));

			expect(onSave.mock.calls[0][9]).toBe('low');
			// Effort belongs to the session; it must not be written into the
			// agent-level config, which only seeds newly created agents.
			expect(window.maestro.agents.setConfig).not.toHaveBeenCalled();
		});

		it('preserves the agent-level model/effort defaults when an agent-level option is edited', async () => {
			// agents:setConfig replaces the whole object, so a blur-save that rebuilt
			// the config from the panel state used to erase the agent-level defaults.
			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={createSession({ customEffort: 'max', customModel: 'claude-opus' })}
					existingSessions={[]}
				/>
			);

			const yolo = await screen.findByLabelText('Enabled');
			fireEvent.click(yolo);

			expect(window.maestro.agents.setConfig).toHaveBeenCalledWith('claude-code', {
				model: 'claude-sonnet', // agent-level default preserved, not the session's opus
				contextWindow: 200000,
				effort: 'high', // agent-level default preserved, not the session's max
				yoloMode: true,
			});
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
			expect.anything(), // effort
			expect.anything(), // contextWindow
			expect.objectContaining({ enabled: false }), // SSH disabled
			undefined, // enableMaestroP
			undefined, // maestroPPath
			undefined, // maestroPMode
			true, // retryOnAvailabilityErrors
			true, // retryOnTokenExhaustion
			undefined, // additionalDirectories
			undefined // contextWindowSource: the window was not touched, so no
			// provenance is recorded and P1 precedence stands (finding AD1)
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
				// No workingDirOverride - this is the regression scenario
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
			'', // effort (no session override, none in agent config)
			100000, // contextWindow
			expect.objectContaining({
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/home/devuser/my-project',
			}),
			undefined, // enableMaestroP
			undefined, // maestroPPath
			undefined, // maestroPMode
			true, // retryOnAvailabilityErrors
			true, // retryOnTokenExhaustion
			undefined, // additionalDirectories
			undefined // contextWindowSource: the window was not touched, so no
			// provenance is recorded and P1 precedence stands (finding AD1)
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
			'', // effort (no session override, none in agent config)
			100000, // contextWindow
			expect.objectContaining({
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/explicit/remote/path',
			}),
			undefined, // enableMaestroP
			undefined, // maestroPPath
			undefined, // maestroPMode
			true, // retryOnAvailabilityErrors
			true, // retryOnTokenExhaustion
			undefined, // additionalDirectories
			undefined // contextWindowSource: the window was not touched, so no
			// provenance is recorded and P1 precedence stands (finding AD1)
		);
	});

	it('should preserve shareHistoryToProjectDir when toggling the SSH dropdown (regression: remote-controlled flag was silently dropped)', async () => {
		// Regression test: the SSH dropdown's onChange used to rebuild the config
		// with only enabled/remoteId/syncHistory, silently dropping
		// shareHistoryToProjectDir (the "This agent is remote-controlled" toggle).
		// Switching from a remote to Local Execution would wipe the flag on save.
		const sshSession = createSession({
			projectRoot: '/home/devuser/project',
			cwd: '/home/devuser/project',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/home/devuser/project',
				shareHistoryToProjectDir: true,
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

		// Wait for the SSH dropdown to render with the remote selected
		const dropdown = (await screen.findByDisplayValue(/Dev Server/)) as HTMLSelectElement;

		// Switch the dropdown to Local Execution - this is the action that used
		// to wipe shareHistoryToProjectDir.
		fireEvent.change(dropdown, { target: { value: 'local' } });

		fireEvent.click(screen.getByText('Save Changes'));

		// shareHistoryToProjectDir must survive the dropdown toggle.
		expect(onSave).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(String),
			undefined,
			'Be concise',
			undefined,
			'/custom/claude',
			'--verbose',
			{ API_KEY: 'test-key' },
			'claude-sonnet',
			'', // effort
			100000,
			expect.objectContaining({
				enabled: false,
				remoteId: null,
				shareHistoryToProjectDir: true,
			}),
			undefined, // enableMaestroP
			undefined, // maestroPPath
			undefined, // maestroPMode
			true, // retryOnAvailabilityErrors
			true, // retryOnTokenExhaustion
			undefined, // additionalDirectories
			undefined // contextWindowSource: the window was not touched, so no
			// provenance is recorded and P1 precedence stands (finding AD1)
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

	// Finding AD1: provenance for `customContextWindow`.
	describe('context window provenance (finding AD1)', () => {
		const agentWithWindow = {
			id: 'claude-code',
			name: 'Claude Code',
			available: true,
			path: '/usr/local/bin/claude',
			binaryName: 'claude',
			hidden: false,
			configOptions: [
				{ key: 'model', type: 'text', label: 'Model', default: '' },
				{
					key: 'contextWindow',
					type: 'number',
					label: 'Context Window Size',
					default: 200000,
				},
			],
		} as unknown as AgentConfig;

		beforeEach(() => {
			// Seeded store entries must not leak between cases: the note reads the
			// live store, so a leftover session would silently satisfy another test.
			useSessionStore.setState({ sessions: [] } as never);
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([agentWithWindow]);
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
				model: 'claude-sonnet',
				contextWindow: 200000,
			});
		});

		// #1370: the stored number stays visible in this control while the gauge,
		// the Context Timeline and compaction all divide by the provider's window
		// instead. The control looks like it configures something; it does not.
		describe('override note (#1370)', () => {
			const withUsage = (
				overrides: Partial<Session>,
				usageStats?: Record<string, unknown>
			): Session =>
				createSession({
					...overrides,
					activeTabId: 'tab-1',
					aiTabs: [{ id: 'tab-1', usageStats }],
				} as Partial<Session>);

			const note = () => screen.queryByTestId('config-option-note-contextWindow');

			it('explains the override when a provider window outranks a materialized value', async () => {
				render(
					<EditAgentModal
						isOpen={true}
						onClose={onClose}
						onSave={onSave}
						theme={theme}
						session={withUsage(
							{ customContextWindow: 200000 },
							{
								contextWindow: 1_000_000,
								contextWindowResolved: true,
							}
						)}
						existingSessions={[]}
					/>
				);

				await screen.findByDisplayValue('200000');
				// Names the window actually in use, so the number in the field is not
				// the only figure on screen.
				expect(note()).toHaveTextContent('1.0M');
				expect(note()).toHaveTextContent(/edit this field/i);
			});

			it('stays silent when the stored window is user-edited', async () => {
				render(
					<EditAgentModal
						isOpen={true}
						onClose={onClose}
						onSave={onSave}
						theme={theme}
						session={withUsage(
							{ customContextWindow: 120000, contextWindowSource: 'user-edited' },
							{ contextWindow: 1_000_000, contextWindowResolved: true }
						)}
						existingSessions={[]}
					/>
				);

				await screen.findByDisplayValue('120000');
				// The value is winning, so there is nothing to explain.
				expect(note()).not.toBeInTheDocument();
			});

			it('stays silent when the reported window carries no authority flag', async () => {
				render(
					<EditAgentModal
						isOpen={true}
						onClose={onClose}
						onSave={onSave}
						theme={theme}
						session={withUsage({ customContextWindow: 200000 }, { contextWindow: 1_000_000 })}
						existingSessions={[]}
					/>
				);

				await screen.findByDisplayValue('200000');
				// An unflagged report may be a parser-injected static fallback, so the
				// stored value is still the one in use.
				expect(note()).not.toBeInTheDocument();
			});

			it('stays silent when nothing is stored to override', async () => {
				const { customContextWindow: _drop, ...withoutWindow } = createSession() as Record<
					string,
					unknown
				>;
				render(
					<EditAgentModal
						isOpen={true}
						onClose={onClose}
						onSave={onSave}
						theme={theme}
						session={
							{
								...withoutWindow,
								activeTabId: 'tab-1',
								aiTabs: [
									{
										id: 'tab-1',
										usageStats: { contextWindow: 1_000_000, contextWindowResolved: true },
									},
								],
							} as unknown as Session
						}
						existingSessions={[]}
					/>
				);

				await screen.findByDisplayValue('200000');
				expect(note()).not.toBeInTheDocument();
			});

			it('follows the live store when usage lands while the modal is open', async () => {
				// The `session` prop is a snapshot from when the modal opened, so a
				// turn completing mid-edit would leave the note missing or naming a
				// stale winner (review of #1371). Snapshot has no usage; the store
				// entry does.
				const snapshot = withUsage({ customContextWindow: 200000 }, undefined);
				useSessionStore.setState({
					sessions: [
						withUsage(
							{ customContextWindow: 200000 },
							{
								contextWindow: 1_000_000,
								contextWindowResolved: true,
							}
						),
					],
				} as never);

				render(
					<EditAgentModal
						isOpen={true}
						onClose={onClose}
						onSave={onSave}
						theme={theme}
						session={snapshot}
						existingSessions={[]}
					/>
				);

				await screen.findByDisplayValue('200000');
				expect(note()).toHaveTextContent('1.0M');
			});

			it('stays silent while a provider switch is pending', async () => {
				// Mid-switch the panel already shows the NEW provider's config, so a
				// note describing the OLD provider's window would caption the wrong
				// control (review of #1371).
				//
				// codex MUST be in the detect mock: without it `agent` resolves to null
				// after the switch and the whole config panel unmounts, so the note
				// would be absent for a reason that has nothing to do with the guard.
				vi.mocked(window.maestro.agents.detect).mockResolvedValue([
					agentWithWindow,
					{ ...agentWithWindow, id: 'codex', name: 'Codex' } as unknown as AgentConfig,
				]);
				render(
					<EditAgentModal
						isOpen={true}
						onClose={onClose}
						onSave={onSave}
						theme={theme}
						session={withUsage(
							{ customContextWindow: 200000 },
							{
								contextWindow: 1_000_000,
								contextWindowResolved: true,
							}
						)}
						existingSessions={[]}
					/>
				);

				// Note is present before the switch...
				await screen.findByDisplayValue('200000');
				expect(note()).toBeInTheDocument();

				// ...and gone once a different provider is selected. The provider
				// control is a <select>, so change it rather than clicking a label.
				fireEvent.change(screen.getByDisplayValue('Claude Code'), {
					target: { value: 'codex' },
				});
				// The control itself is still on screen - the note is gone, not the panel.
				await waitFor(() => expect(note()).not.toBeInTheDocument());
				expect(screen.getByDisplayValue('200000')).toBeInTheDocument();
			});

			it('credits the model marker rather than the provider when it is what won', async () => {
				render(
					<EditAgentModal
						isOpen={true}
						onClose={onClose}
						onSave={onSave}
						theme={theme}
						session={withUsage(
							{ customContextWindow: 200000, customModel: 'opus[1m]' },
							{
								contextWindow: 500000,
								contextWindowResolved: true,
							}
						)}
						existingSessions={[]}
					/>
				);

				await screen.findByDisplayValue('200000');
				expect(note()).toHaveTextContent(/selected model/i);
				expect(note()).toHaveTextContent('1.0M');
			});
		});

		// Finding AD1. This modal is HOW the agent-level default gets materialized
		// into a per-session override (finding P1): with no stored value the panel
		// seeds from `globalConfig.contextWindow`, and pressing Save writes that
		// number to the session. If that write were recorded as 'user-edited' it
		// would outrank the provider's own report and reinstate the exact bug P1
		// removed - so the seed comparison, not the presence of a value, is what
		// decides provenance.
		it('does not mark an untouched seeded context window as user-edited', async () => {
			const { customContextWindow: _drop, ...withoutWindow } = createSession() as Record<
				string,
				unknown
			>;

			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={withoutWindow as unknown as Session}
					existingSessions={[]}
				/>
			);

			// Seeded from the agent-level config because the session has none.
			expect(await screen.findByDisplayValue('200000')).toBeInTheDocument();

			fireEvent.click(screen.getByText('Save Changes'));

			const args = onSave.mock.calls[0];
			// The value still materializes onto the session, exactly as before...
			expect(args[10]).toBe(200000);
			// ...but carries no provenance, so P1's precedence still applies to it.
			expect(args[18]).toBeUndefined();
		});

		it('clears provenance when the user clears the context window', async () => {
			// Review of PR #1362 (CodeRabbit). Clearing the control makes the value
			// undefined, which differs from the numeric seed and so used to be
			// recorded as a deliberate edit. Provenance must die with the value it
			// describes, or the NEXT window set inherits precedence nobody asked for.
			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={createSession({ contextWindowSource: 'user-edited' })}
					existingSessions={[]}
				/>
			);

			const input = await screen.findByDisplayValue('100000');
			fireEvent.change(input, { target: { value: '' } });

			fireEvent.click(screen.getByText('Save Changes'));

			const args = onSave.mock.calls[0];
			expect(args[10]).toBeUndefined();
			expect(args[18]).toBeUndefined();
		});

		it('marks a context window the user actually changed as user-edited', async () => {
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

			const input = await screen.findByDisplayValue('100000');
			fireEvent.change(input, { target: { value: '120000' } });

			fireEvent.click(screen.getByText('Save Changes'));

			const args = onSave.mock.calls[0];
			expect(args[10]).toBe(120000);
			expect(args[18]).toBe('user-edited');
		});
	});
});
