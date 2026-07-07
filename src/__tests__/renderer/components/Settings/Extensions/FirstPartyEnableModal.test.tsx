/**
 * FirstPartyEnableModal — the pre-enable permission review surface.
 *
 * This modal is the visible half of the enable gate: it discloses the
 * capabilities a first-party feature will be granted BEFORE anything is
 * minted, and turns the user's choice into onConfirm / onCancel. The tests
 * assert what a consumer depends on: the feature name is shown, one review row
 * per declared permission renders (via the shared PermissionList) labeled
 * "Will be granted", the confirm/cancel buttons fire their callbacks, and the
 * zero-permission case degrades to honest "no special capabilities" copy
 * instead of an empty list.
 *
 * The modal renders through the shared Modal, which registers with the layer
 * stack, so it is wrapped in LayerStackProvider (required — Modal throws
 * without it). That also lets us prove Escape routes to onCancel.
 */
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { FirstPartyEnableModal } from '../../../../../renderer/components/Settings/Extensions/FirstPartyEnableModal';
import { LayerStackProvider } from '../../../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../../../helpers/mockTheme';
import type { PermissionRequest } from '../../../../../shared/plugins/permissions';

// A representative spread across risk buckets, with scope + reason so the row
// layout is exercised, not just a single trivial capability.
const PERMISSIONS: readonly PermissionRequest[] = [
	{ capability: 'settings:read', reason: 'Re-read the feature flag before acting.' },
	{ capability: 'net:fetch', scope: 'github.com', reason: 'Poll GitHub for updates.' },
	{ capability: 'process:spawn', reason: 'Run a supervised host binary.' },
];

function renderModal(overrides: Partial<React.ComponentProps<typeof FirstPartyEnableModal>> = {}): {
	onConfirm: ReturnType<typeof vi.fn>;
	onCancel: ReturnType<typeof vi.fn>;
} {
	const onConfirm = vi.fn();
	const onCancel = vi.fn();
	render(
		<LayerStackProvider>
			<FirstPartyEnableModal
				theme={mockTheme}
				name="Maestro Cue"
				permissions={PERMISSIONS}
				onConfirm={onConfirm}
				onCancel={onCancel}
				{...overrides}
			/>
		</LayerStackProvider>
	);
	return { onConfirm, onCancel };
}

afterEach(cleanup);

describe('FirstPartyEnableModal', () => {
	it('renders the container and the feature name in the title and body', () => {
		renderModal();
		expect(screen.getByTestId('first-party-enable-modal')).toBeInTheDocument();
		// Title "Enable {name}" is the confirm button label too; the aria-label
		// on the dialog carries the title. Assert the name appears in the body copy.
		expect(screen.getByText(/Maestro Cue is a built-in Maestro feature/i)).toBeInTheDocument();
		expect(screen.getByTestId('first-party-enable-confirm')).toHaveTextContent(
			'Enable Maestro Cue'
		);
	});

	it('renders one review row per declared permission, labeled "Will be granted"', () => {
		renderModal();
		const rows = screen.getAllByTestId('extension-permission');
		expect(rows).toHaveLength(PERMISSIONS.length);
		expect(rows.map((r) => r.getAttribute('data-cap'))).toEqual(
			PERMISSIONS.map((p) => p.capability)
		);
		for (const status of screen.getAllByTestId('extension-permission-status')) {
			expect(status.textContent).toBe('Will be granted');
		}
	});

	it('clicking confirm fires onConfirm and nothing else', () => {
		const { onConfirm, onCancel } = renderModal();
		fireEvent.click(screen.getByTestId('first-party-enable-confirm'));
		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(onCancel).not.toHaveBeenCalled();
	});

	it('clicking cancel fires onCancel and does not confirm', () => {
		const { onConfirm, onCancel } = renderModal();
		fireEvent.click(screen.getByTestId('first-party-enable-cancel'));
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it('Escape routes to onCancel via the layer stack', async () => {
		const { onConfirm, onCancel } = renderModal();
		await act(async () => {
			document.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
			);
		});
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it('renders honest "no special capabilities" copy when permissions are empty', () => {
		renderModal({ permissions: [] });
		expect(screen.queryByTestId('extension-permission')).not.toBeInTheDocument();
		expect(screen.getByText(/requests no special capabilities/i)).toBeInTheDocument();
	});
});
