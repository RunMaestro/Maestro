/**
 * @file SshRemoteModal.test.tsx
 * @description The per-remote Federation switch. Federation is opportunistic:
 * the switch is always shown, starts on, and only an opt-out (`federation:
 * false`) is ever saved.
 */

import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { SshRemoteModal } from '../../../../renderer/components/Settings/SshRemoteModal';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
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
});

describe('SshRemoteModal federation toggle', () => {
	it('is on for a remote with no federation field, and saves nothing for it', async () => {
		const { onSave } = renderModal(existing);
		const toggle = screen.getByRole('switch', { name: 'Federation' });
		expect(toggle).toHaveAttribute('aria-checked', 'true');
		expect((await save(onSave)).federation).toBeUndefined();
	});

	it('saves the opt-out when switched off', async () => {
		const { onSave } = renderModal(existing);
		const toggle = screen.getByRole('switch', { name: 'Federation' });
		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute('aria-checked', 'false');
		expect(await save(onSave)).toMatchObject({ id: 'r1', federation: false });
	});

	it('reflects an existing opt-out and clears it when switched back on', async () => {
		const { onSave } = renderModal({ ...existing, federation: false });
		const toggle = screen.getByRole('switch', { name: 'Federation' });
		expect(toggle).toHaveAttribute('aria-checked', 'false');

		fireEvent.click(toggle);
		expect((await save(onSave)).federation).toBeUndefined();
	});

	it('starts on for a new remote', () => {
		renderModal();
		expect(screen.getByRole('switch', { name: 'Federation' })).toHaveAttribute(
			'aria-checked',
			'true'
		);
	});

	it('still toggles Enable this remote through the shared switch', async () => {
		const { onSave } = renderModal(existing);
		fireEvent.click(screen.getByRole('switch', { name: 'Enable this remote' }));
		expect(await save(onSave)).toMatchObject({ enabled: false });
	});
});
