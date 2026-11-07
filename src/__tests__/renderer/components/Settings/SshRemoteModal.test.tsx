/**
 * @file SshRemoteModal.test.tsx
 * @description The per-remote Federation opt-in: the toggle exists only while
 * the `federation` Encore Feature is on, it saves `federation: true`, and an
 * edit made while the feature is off keeps the remote's existing opt-in.
 */

import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { SshRemoteModal } from '../../../../renderer/components/Settings/SshRemoteModal';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { mockTheme } from '../../../helpers/mockTheme';
import type { SshRemoteConfig } from '../../../../shared/types';

const existing: SshRemoteConfig = {
	id: 'r1',
	name: 'pedtome',
	host: 'pedtome-tailcat',
	port: 22,
	username: 'pedram',
	privateKeyPath: '',
	enabled: true,
};

function setFederationFeature(on: boolean): void {
	useSettingsStore.setState((s) => ({
		encoreFeatures: { ...s.encoreFeatures, federation: on },
	}));
}

function renderModal(initialConfig?: SshRemoteConfig) {
	const onSave = vi.fn(async (config: Partial<SshRemoteConfig>) => ({
		success: true,
		config: config as SshRemoteConfig,
	}));
	render(
		<LayerStackProvider>
			<SshRemoteModal
				theme={mockTheme}
				isOpen
				onClose={vi.fn()}
				onSave={onSave}
				initialConfig={initialConfig}
			/>
		</LayerStackProvider>
	);
	return { onSave };
}

async function save(onSave: ReturnType<typeof renderModal>['onSave']) {
	fireEvent.click(screen.getByRole('button', { name: 'Save' }));
	await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
	return onSave.mock.calls[0][0];
}

beforeEach(() => {
	(window as unknown as { maestro: unknown }).maestro = {
		...((window as unknown as { maestro?: object }).maestro ?? {}),
		sshRemote: { getSshConfigHosts: vi.fn().mockResolvedValue({ success: true, hosts: [] }) },
	};
});

afterEach(() => {
	cleanup();
	setFederationFeature(false);
});

describe('SshRemoteModal federation toggle', () => {
	it('is absent while the Encore Feature is off', () => {
		setFederationFeature(false);
		renderModal(existing);
		expect(screen.queryByTestId('ssh-remote-federation-toggle')).not.toBeInTheDocument();
		expect(screen.queryByRole('switch', { name: 'Federation' })).not.toBeInTheDocument();
	});

	it('shows when the feature is on and saves the opt-in', async () => {
		setFederationFeature(true);
		const { onSave } = renderModal(existing);
		const toggle = screen.getByRole('switch', { name: 'Federation' });
		expect(toggle).toHaveAttribute('aria-checked', 'false');

		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute('aria-checked', 'true');

		expect(await save(onSave)).toMatchObject({ id: 'r1', federation: true });
	});

	it('reflects an existing opt-in and saves it off as absent', async () => {
		setFederationFeature(true);
		const { onSave } = renderModal({ ...existing, federation: true });
		const toggle = screen.getByRole('switch', { name: 'Federation' });
		expect(toggle).toHaveAttribute('aria-checked', 'true');

		fireEvent.click(toggle);
		const saved = await save(onSave);
		expect(saved.federation).toBeUndefined();
	});

	it('keeps an existing opt-in when the remote is edited with the feature off', async () => {
		setFederationFeature(false);
		const { onSave } = renderModal({ ...existing, federation: true });
		expect(await save(onSave)).toMatchObject({ federation: true });
	});

	it('still toggles Enable this remote through the shared switch', async () => {
		const { onSave } = renderModal(existing);
		fireEvent.click(screen.getByRole('switch', { name: 'Enable this remote' }));
		expect(await save(onSave)).toMatchObject({ enabled: false });
	});
});
