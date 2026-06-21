import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SshRemotesSection } from '../../renderer/components/Settings/SshRemotesSection';
import type { Theme } from '../../renderer/types';
import type { SshRemoteConfig } from '../../shared/types';

type HookState = {
	configs: SshRemoteConfig[];
	defaultId: string | null;
	loading: boolean;
	error: string | null;
	saveConfig: ReturnType<typeof vi.fn>;
	deleteConfig: ReturnType<typeof vi.fn>;
	setDefaultId: ReturnType<typeof vi.fn>;
	testConnection: ReturnType<typeof vi.fn>;
	testingConfigId: string | null;
};

const mocks = vi.hoisted(() => ({
	hookState: {} as HookState,
	loggerError: vi.fn(),
	modalProps: [] as Array<{
		isOpen: boolean;
		initialConfig?: SshRemoteConfig;
	}>,
}));

vi.mock('../../renderer/hooks', () => ({
	useSshRemotes: () => mocks.hookState,
}));

vi.mock('../../renderer/utils/logger', () => ({
	logger: {
		error: mocks.loggerError,
	},
}));

vi.mock('../../renderer/components/Settings/SshRemoteModal', () => ({
	SshRemoteModal: ({ isOpen, onClose, onSave, onTestConnection, initialConfig }: any) => {
		mocks.modalProps.push({ isOpen, initialConfig });
		if (!isOpen) return null;

		return (
			<div data-testid="ssh-remote-modal">
				<span>{initialConfig ? `Editing ${initialConfig.name}` : 'Adding SSH remote'}</span>
				<button type="button" onClick={() => onSave({ id: 'saved-remote', name: 'Saved' })}>
					Save remote
				</button>
				<button
					type="button"
					onClick={() =>
						onTestConnection({
							id: 'modal-remote',
							name: 'Modal Remote',
							host: 'modal.example.com',
							port: 22,
							username: 'modal',
							privateKeyPath: '~/.ssh/modal',
							enabled: true,
						})
					}
				>
					Test from modal
				</button>
				<button type="button" onClick={onClose}>
					Close modal
				</button>
			</div>
		);
	},
}));

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
		success: '#33cc66',
	},
};

function createConfig(overrides: Partial<SshRemoteConfig> = {}): SshRemoteConfig {
	return {
		id: 'remote-1',
		name: 'Build Box',
		host: 'build.example.com',
		port: 22,
		username: 'builder',
		privateKeyPath: '~/.ssh/build',
		enabled: true,
		...overrides,
	};
}

function setHookState(overrides: Partial<HookState> = {}) {
	mocks.hookState = {
		configs: [],
		defaultId: null,
		loading: false,
		error: null,
		saveConfig: vi.fn().mockResolvedValue({ success: true, config: createConfig() }),
		deleteConfig: vi.fn().mockResolvedValue({ success: true }),
		setDefaultId: vi.fn().mockResolvedValue({ success: true }),
		testConnection: vi.fn().mockResolvedValue({
			success: true,
			result: { success: true, remoteInfo: { hostname: 'remote-host' } },
		}),
		testingConfigId: null,
		...overrides,
	};
}

function renderSection() {
	return render(<SshRemotesSection theme={theme} />);
}

describe('SshRemotesSection', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.modalProps.length = 0;
		setHookState();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('renders the loading state without the management controls', () => {
		setHookState({ loading: true });

		renderSection();

		expect(screen.getByText('Loading SSH remotes...')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Add SSH Remote/i })).not.toBeInTheDocument();
	});

	it('renders the empty/error state and closes the add modal after a successful save', async () => {
		setHookState({ error: 'Failed to load remotes' });

		renderSection();

		expect(screen.getByText('Remote Execution')).toBeInTheDocument();
		expect(screen.getByText('Failed to load remotes')).toBeInTheDocument();
		expect(screen.getByText('No SSH remotes configured')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Add SSH Remote/i }));
		expect(screen.getByTestId('ssh-remote-modal')).toHaveTextContent('Adding SSH remote');

		fireEvent.click(screen.getByRole('button', { name: /Save remote/i }));

		await waitFor(() => {
			expect(screen.queryByTestId('ssh-remote-modal')).not.toBeInTheDocument();
		});
		expect(mocks.hookState.saveConfig).toHaveBeenCalledWith({
			id: 'saved-remote',
			name: 'Saved',
		});
	});

	it('keeps the add modal open when saving fails and delegates modal connection tests', async () => {
		setHookState({
			saveConfig: vi.fn().mockResolvedValue({ success: false, error: 'Validation failed' }),
		});

		renderSection();
		fireEvent.click(screen.getByRole('button', { name: /Add SSH Remote/i }));
		fireEvent.click(screen.getByRole('button', { name: /Save remote/i }));

		await waitFor(() => {
			expect(screen.getByTestId('ssh-remote-modal')).toBeInTheDocument();
		});

		fireEvent.click(screen.getByRole('button', { name: /Test from modal/i }));
		expect(mocks.hookState.testConnection).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'modal-remote', host: 'modal.example.com' })
		);
	});

	it('renders configured remotes with default, disabled, testing, and connection-result states', async () => {
		const defaultConfig = createConfig();
		const fallbackConfig = createConfig({
			id: 'remote-2',
			name: 'Fallback Box',
			host: 'fallback.example.com',
			username: 'fallback',
		});
		const disabledConfig = createConfig({
			id: 'remote-3',
			name: 'Disabled Box',
			host: 'disabled.example.com',
			enabled: false,
		});
		const testingConfig = createConfig({
			id: 'remote-4',
			name: 'Testing Box',
			host: 'testing.example.com',
		});
		const testConnection = vi
			.fn()
			.mockResolvedValueOnce({
				success: true,
				result: { success: true, remoteInfo: { hostname: 'build-host' } },
			})
			.mockResolvedValueOnce({
				success: true,
				result: { success: true },
			})
			.mockResolvedValueOnce({ success: false, error: 'Permission denied' })
			.mockResolvedValueOnce({ success: false });
		setHookState({
			configs: [defaultConfig, fallbackConfig, disabledConfig, testingConfig],
			defaultId: 'remote-1',
			testingConfigId: 'remote-4',
			testConnection,
		});

		renderSection();

		expect(screen.getByText('Build Box')).toBeInTheDocument();
		expect(screen.getByText('Default')).toBeInTheDocument();
		expect(screen.getByText('Disabled Box')).toBeInTheDocument();
		expect(screen.getByText('Disabled')).toBeInTheDocument();
		expect(screen.queryByText('No SSH remotes configured')).not.toBeInTheDocument();

		const testButtons = screen.getAllByTitle('Test connection');
		expect(testButtons[2]).toBeDisabled();
		expect(testButtons[3]).toBeDisabled();

		fireEvent.click(testButtons[0]);
		await waitFor(() => {
			expect(screen.getByText('Connected to Build Box')).toBeInTheDocument();
		});

		fireEvent.click(testButtons[1]);
		await waitFor(() => {
			expect(screen.getByText('Connected to Fallback Box')).toBeInTheDocument();
		});

		fireEvent.click(testButtons[0]);
		await waitFor(() => {
			expect(screen.getByText('Permission denied')).toBeInTheDocument();
		});

		fireEvent.click(testButtons[1]);
		await waitFor(() => {
			expect(screen.getByText('Connection failed')).toBeInTheDocument();
		});
		expect(testConnection).toHaveBeenCalledWith(defaultConfig);
		expect(testConnection).toHaveBeenCalledWith(fallbackConfig);
	});

	it('toggles defaults, opens edit mode, and closes the edit modal', () => {
		const defaultConfig = createConfig();
		const fallbackConfig = createConfig({ id: 'remote-2', name: 'Fallback Box' });
		setHookState({
			configs: [defaultConfig, fallbackConfig],
			defaultId: 'remote-1',
		});

		renderSection();

		fireEvent.click(screen.getByTitle('Remove as default'));
		fireEvent.click(screen.getByTitle('Set as default'));
		expect(mocks.hookState.setDefaultId).toHaveBeenNthCalledWith(1, null);
		expect(mocks.hookState.setDefaultId).toHaveBeenNthCalledWith(2, 'remote-2');

		const editButtons = screen.getAllByTitle('Edit');
		fireEvent.click(editButtons[1]);
		expect(screen.getByTestId('ssh-remote-modal')).toHaveTextContent('Editing Fallback Box');

		fireEvent.click(screen.getByRole('button', { name: /Close modal/i }));
		expect(screen.queryByTestId('ssh-remote-modal')).not.toBeInTheDocument();
	});

	it('shows delete progress, clears prior test results on success, and logs expected delete failures', async () => {
		let resolveDelete: (value: { success: boolean; error?: string }) => void = () => {};
		const deleteConfig = vi
			.fn()
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveDelete = resolve;
				})
			)
			.mockResolvedValueOnce({ success: false, error: 'Config in use' });
		setHookState({
			configs: [createConfig()],
			deleteConfig,
			testConnection: vi.fn().mockResolvedValue({
				success: true,
				result: { success: true, remoteInfo: { hostname: 'build-host' } },
			}),
		});

		renderSection();
		fireEvent.click(screen.getByTitle('Test connection'));
		await waitFor(() => {
			expect(screen.getByText('Connected to Build Box')).toBeInTheDocument();
		});

		const deleteButton = screen.getByTitle('Delete');
		fireEvent.click(deleteButton);
		await waitFor(() => {
			expect(deleteButton).toBeDisabled();
		});

		resolveDelete({ success: true });
		await waitFor(() => {
			expect(screen.queryByText('Connected to Build Box')).not.toBeInTheDocument();
		});

		fireEvent.click(screen.getByTitle('Delete'));
		await waitFor(() => {
			expect(mocks.loggerError).toHaveBeenCalledWith(
				'Failed to delete SSH remote:',
				undefined,
				'Config in use'
			);
		});
		expect(deleteConfig).toHaveBeenCalledWith('remote-1');
	});
});
