/**
 * ExtensionDetails first-party disclosure surfaces:
 * - Supervised background services (from the shared first-party registry)
 *   with a status line derived from the tile's enabled state — no polling.
 * - The declared permission list (capability risk + description + reason)
 *   rendered statically as "Granted on enable" — grants are minted host-side
 *   by the lifecycle bridge, so no getGrants IPC round-trip for builtins.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { ExtensionDetails } from '../../../../../renderer/components/Settings/Extensions/ExtensionDetails';
import {
	BUILTIN_FEATURES,
	builtinExtension,
} from '../../../../../renderer/components/Settings/Extensions/extensionModel';
import type { EncoreFeatureFlags } from '../../../../../renderer/types';
import type { Theme } from '../../../../../renderer/types';

const theme = {
	colors: {
		textMain: '#eee',
		textDim: '#999',
		bgMain: '#111',
		accent: '#4af',
		border: '#333',
		warning: '#fa0',
		error: '#f44',
		success: '#4f4',
	},
} as unknown as Theme;

const flags = (overrides: Partial<EncoreFeatureFlags> = {}): EncoreFeatureFlags => ({
	directorNotes: false,
	usageStats: false,
	symphony: false,
	maestroCue: false,
	pianola: false,
	plugins: false,
	...overrides,
});

function renderBuiltin(flag: keyof EncoreFeatureFlags, enabled: boolean): void {
	const def = BUILTIN_FEATURES.find((f) => f.flag === flag);
	if (!def) throw new Error(`no builtin feature for flag ${flag}`);
	render(
		<ExtensionDetails
			theme={theme}
			ext={builtinExtension(def, flags({ [flag]: enabled }))}
			contributions={null}
			busy={false}
			onBack={vi.fn()}
			onTogglePlugin={vi.fn()}
			onToggleBuiltin={vi.fn()}
			onUninstall={vi.fn()}
			onRevoke={vi.fn()}
			getGrants={vi.fn(async () => ({ requested: [], granted: [] }))}
		/>
	);
	// Background services + permission disclosure live under the Permissions
	// sub-tab. Tiles with a Settings tab (e.g. Pianola) open on Settings, so
	// select Permissions explicitly; for Permissions-only tiles this is a no-op.
	fireEvent.click(screen.getByTestId('extension-subtab-permissions'));
}

afterEach(cleanup);

describe('ExtensionDetails first-party background services', () => {
	it('shows pianola.supervisor as Running (supervised) when the feature is enabled', () => {
		renderBuiltin('pianola', true);
		const row = screen.getByTestId('extension-background-service');
		expect(row.getAttribute('data-service')).toBe('pianola.supervisor');
		expect(screen.getByTestId('extension-background-service-status').textContent).toBe(
			'Running (supervised)'
		);
	});

	it('shows pianola.supervisor as Stopped when the feature is disabled', () => {
		renderBuiltin('pianola', false);
		expect(screen.getByTestId('extension-background-service-status').textContent).toBe('Stopped');
	});

	it('renders no background-service section for a first-party feature without services', () => {
		// Symphony's definition declares no background services.
		renderBuiltin('symphony', true);
		expect(screen.queryByTestId('extension-background-service')).toBeNull();
	});
});

describe('ExtensionDetails first-party permission disclosure', () => {
	it('renders one row per declared permission, labeled "Granted on enable"', () => {
		renderBuiltin('directorNotes', false);
		const def = BUILTIN_FEATURES.find((f) => f.flag === 'directorNotes')!;
		const rows = screen.getAllByTestId('extension-permission');
		expect(rows).toHaveLength(def.pluginBacking.permissions.length);
		const caps = rows.map((r) => r.getAttribute('data-cap'));
		expect(caps).toEqual(def.pluginBacking.permissions.map((p) => p.capability));
		for (const status of screen.getAllByTestId('extension-permission-status')) {
			expect(status.textContent).toBe('Granted on enable');
		}
	});

	it('shows the declared reason text so disclosure is meaningful', () => {
		renderBuiltin('pianola', true);
		expect(screen.getByText(/Record Pianola decisions before any dispatch/i)).toBeInTheDocument();
	});

	it('never calls the grants IPC for a first-party tile (static disclosure)', () => {
		const def = BUILTIN_FEATURES.find((f) => f.flag === 'maestroCue')!;
		const getGrants = vi.fn(async () => ({ requested: [], granted: [] }));
		render(
			<ExtensionDetails
				theme={theme}
				ext={builtinExtension(def, flags({ maestroCue: true }))}
				contributions={null}
				busy={false}
				onBack={vi.fn()}
				onTogglePlugin={vi.fn()}
				onToggleBuiltin={vi.fn()}
				onUninstall={vi.fn()}
				onRevoke={vi.fn()}
				getGrants={getGrants}
			/>
		);
		expect(screen.getAllByTestId('extension-permission').length).toBeGreaterThan(0);
		expect(getGrants).not.toHaveBeenCalled();
	});
});
