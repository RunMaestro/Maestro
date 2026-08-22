/**
 * The "How to use it" block in the Extensions details pane.
 *
 * A user who turns a feature on and cannot work out how to summon it has been
 * failed by the panel, so these pin the two things that make the block worth
 * having: that it names every way in (hotkey, command palette, menu), and that
 * the hotkey it prints is the user's LIVE binding rather than text baked into
 * the feature definition - a rebound key must never leave the panel advertising
 * a combination that does nothing.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionDetails } from '../../../../../renderer/components/Settings/Extensions/ExtensionDetails';
import { builtinExtension } from '../../../../../renderer/components/Settings/Extensions/extensionModel';
import type { UnifiedExtension } from '../../../../../renderer/components/Settings/Extensions/extensionModel';
import { CONCERTO_FIRST_PARTY_PLUGIN } from '../../../../../shared/plugins/first-party';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import { DEFAULT_SHORTCUTS } from '../../../../../renderer/constants/shortcuts';
import { formatShortcutKeys } from '../../../../../renderer/utils/shortcutFormatter';
import type { Theme } from '../../../../../renderer/types';

const theme = {
	colors: {
		textMain: '#eee',
		textDim: '#999',
		bgMain: '#111',
		bgSidebar: '#222',
		accent: '#4af',
		border: '#333',
		warning: '#fa0',
		error: '#f44',
		success: '#4f4',
	},
} as unknown as Theme;

function renderDetails(ext: UnifiedExtension): void {
	render(
		<ExtensionDetails
			theme={theme}
			ext={ext}
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
}

/** The real Concerto tile, projected exactly as the grid projects it. */
function concertoExtension(): UnifiedExtension {
	return builtinExtension(
		{ flag: 'concerto', beta: true, pluginBacking: CONCERTO_FIRST_PARTY_PLUGIN },
		{ concerto: true } as never
	);
}

afterEach(cleanup);

describe('ExtensionDetails usage guide', () => {
	beforeEach(() => {
		useSettingsStore.setState({ shortcuts: { ...DEFAULT_SHORTCUTS } as never });
	});

	it('tells the user how to open the feature, not just what it is', () => {
		renderDetails(concertoExtension());

		const guide = screen.getByTestId('extension-usage-guide');
		expect(guide.textContent).toContain('Concerto stage');
		// All three ways in are named.
		expect(guide.textContent).toContain('Command palette');
		expect(guide.textContent).toContain('Concerto Stage');
		expect(guide.textContent).toContain('hamburger menu');
	});

	it('prints the live binding, so a rebound key is never advertised stale', () => {
		useSettingsStore.setState({
			shortcuts: {
				...DEFAULT_SHORTCUTS,
				toggleConcerto: {
					id: 'toggleConcerto',
					label: 'Show/Hide Concerto Stage',
					keys: ['Meta', '9'],
				},
			} as never,
		});

		renderDetails(concertoExtension());

		// The keycap shows the rebound key, and the shipped default is gone.
		const keycap = screen.getByText(formatShortcutKeys(['Meta', '9']));
		expect(keycap).toBeInTheDocument();
		expect(
			screen.queryByText(formatShortcutKeys(DEFAULT_SHORTCUTS.toggleConcerto.keys))
		).toBeNull();
	});

	it('shows what an agent types to drive it', () => {
		renderDetails(concertoExtension());

		expect(screen.getByTestId('extension-usage-agent').textContent).toContain(
			'maestro-cli movement add'
		);
	});

	it('renders nothing for a feature with no usage guide', () => {
		const bare = { ...concertoExtension(), usage: undefined };
		renderDetails(bare);

		expect(screen.queryByTestId('extension-usage-guide')).toBeNull();
	});
});
