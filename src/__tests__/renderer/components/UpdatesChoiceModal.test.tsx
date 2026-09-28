import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn(() => 'layer-test'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
}));

import { UpdatesChoiceModal } from '../../../renderer/components/UpdatesChoiceModal';
import type { MaestroCliInstallResult, MaestroCliStatus } from '../../../shared/maestro-cli';
import { mockTheme } from '../../helpers/mockTheme';

function cliStatus(overrides: Partial<MaestroCliStatus> = {}): MaestroCliStatus {
	return {
		expectedVersion: '1.0.0',
		installed: false,
		inPath: false,
		inShellPath: false,
		commandPath: null,
		installedVersion: null,
		versionMatch: false,
		needsInstallOrUpdate: true,
		installDir: '/home/user/.local/bin',
		bundledCliPath: null,
		...overrides,
	};
}

const INSTALLED = cliStatus({
	installed: true,
	inPath: true,
	installedVersion: '1.0.0',
	versionMatch: true,
	needsInstallOrUpdate: false,
});

const maestroWindow = window as unknown as { maestro: Record<string, unknown> };
let originalCliApi: unknown;

function mockCliApi(status: MaestroCliStatus) {
	const installResult: MaestroCliInstallResult = {
		success: true,
		status: INSTALLED,
		pathUpdated: false,
		restartRequired: false,
		shellFilesUpdated: [],
	};
	const api = {
		checkStatus: vi.fn().mockResolvedValue(status),
		installOrUpdate: vi.fn().mockResolvedValue(installResult),
	};
	maestroWindow.maestro.maestroCli = api;
	return api;
}

function renderModal(overrides: Partial<React.ComponentProps<typeof UpdatesChoiceModal>> = {}) {
	const props = {
		theme: mockTheme,
		isOpen: true,
		checkForUpdatesOnStartup: true,
		onCheckForUpdatesOnStartupChange: vi.fn(),
		enableBetaUpdates: false,
		onEnableBetaUpdatesChange: vi.fn(),
		crashReportingEnabled: true,
		onCrashReportingEnabledChange: vi.fn(),
		onDismiss: vi.fn(),
		...overrides,
	};
	render(<UpdatesChoiceModal {...props} />);
	return props;
}

beforeEach(() => {
	originalCliApi = maestroWindow.maestro.maestroCli;
	maestroWindow.maestro.maestroCli = undefined;
});

afterEach(() => {
	cleanup();
	maestroWindow.maestro.maestroCli = originalCliApi;
	vi.restoreAllMocks();
});

describe('UpdatesChoiceModal', () => {
	it('shows the settings it is handed, not the shipped defaults', () => {
		// An existing user who already changed these must see their own answers.
		renderModal({
			checkForUpdatesOnStartup: false,
			enableBetaUpdates: true,
			crashReportingEnabled: false,
		});

		expect(screen.getByRole('switch', { name: 'Check for updates automatically' })).toHaveAttribute(
			'aria-checked',
			'false'
		);
		expect(
			screen.getByRole('switch', { name: 'Include beta and release candidate updates' })
		).toHaveAttribute('aria-checked', 'true');
		expect(screen.getByRole('switch', { name: 'Send anonymous crash reports' })).toHaveAttribute(
			'aria-checked',
			'false'
		);
	});

	it('writes each switch straight through to its setting', () => {
		const props = renderModal();

		fireEvent.click(
			screen.getByRole('switch', { name: 'Include beta and release candidate updates' })
		);
		fireEvent.click(screen.getByRole('switch', { name: 'Send anonymous crash reports' }));
		fireEvent.click(screen.getByRole('switch', { name: 'Check for updates automatically' }));

		expect(props.onEnableBetaUpdatesChange).toHaveBeenCalledWith(true);
		expect(props.onCrashReportingEnabledChange).toHaveBeenCalledWith(false);
		expect(props.onCheckForUpdatesOnStartupChange).toHaveBeenCalledWith(false);
	});

	it('toggles exactly once when the row itself is clicked', () => {
		// The row and the switch inside it are both click targets; a bubbling
		// click must not flip the setting twice and land back where it started.
		const props = renderModal();

		fireEvent.click(screen.getByTestId('updates-choice-beta'));

		expect(props.onEnableBetaUpdatesChange).toHaveBeenCalledTimes(1);
		expect(props.onEnableBetaUpdatesChange).toHaveBeenCalledWith(true);
	});

	it('closes through the confirm button', () => {
		const props = renderModal();
		fireEvent.click(screen.getByTestId('updates-choice-confirm'));
		expect(props.onDismiss).toHaveBeenCalledTimes(1);
	});

	it('draws Back only when there is a step to go back to', () => {
		renderModal();
		expect(screen.queryByTestId('updates-choice-back')).not.toBeInTheDocument();

		cleanup();
		const onBack = vi.fn();
		renderModal({ onBack });
		fireEvent.click(screen.getByTestId('updates-choice-back'));
		expect(onBack).toHaveBeenCalledTimes(1);
	});

	describe('Maestro CLI', () => {
		it('offers one button that installs the CLI when it is missing', async () => {
			const api = mockCliApi(cliStatus());
			renderModal();

			const button = await screen.findByText('Install Maestro CLI');
			fireEvent.click(button);

			expect(api.installOrUpdate).toHaveBeenCalledTimes(1);
			expect(await screen.findByTestId('updates-choice-cli-installed')).toBeInTheDocument();
		});

		it('offers an update when an older CLI is installed', async () => {
			mockCliApi(cliStatus({ installed: true, installedVersion: '0.9.0' }));
			renderModal();

			expect(await screen.findByText('Update Maestro CLI')).toBeInTheDocument();
		});

		it('shows the CLI as installed when it already matches', async () => {
			mockCliApi(INSTALLED);
			renderModal();

			expect(await screen.findByTestId('updates-choice-cli-installed')).toBeInTheDocument();
			expect(screen.queryByTestId('updates-choice-install-cli')).not.toBeInTheDocument();
		});

		it('reports a failed install instead of claiming success', async () => {
			const api = mockCliApi(cliStatus());
			api.installOrUpdate.mockRejectedValue(new Error('EACCES'));
			renderModal();

			fireEvent.click(await screen.findByText('Install Maestro CLI'));

			await waitFor(() =>
				expect(screen.getByRole('alert')).toHaveTextContent('Failed to install/update Maestro CLI')
			);
			expect(screen.queryByTestId('updates-choice-cli-installed')).not.toBeInTheDocument();
		});

		it('hides the CLI block when the bridge has no CLI api', () => {
			renderModal();
			expect(screen.queryByTestId('updates-choice-cli')).not.toBeInTheDocument();
		});
	});
});
