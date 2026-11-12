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
import {
	CONCERTO_FIRST_PARTY_PLUGIN,
	PIANOLA_FIRST_PARTY_PLUGIN,
} from '../../../../../shared/plugins/first-party';
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

/**
 * Pianola is the guide's other shape: a feature with no hotkey that takes
 * several actions to set up, and whose guard rails have to be readable BEFORE
 * someone switches it on. Those two sections (`steps`, `notes`) are optional,
 * so Concerto above also pins that a feature without them draws neither.
 */
describe('ExtensionDetails usage guide - walkthrough and guard rails', () => {
	beforeEach(() => {
		useSettingsStore.setState({ shortcuts: { ...DEFAULT_SHORTCUTS } as never });
	});

	function pianolaExtension(): UnifiedExtension {
		return builtinExtension({ flag: 'pianola', pluginBacking: PIANOLA_FIRST_PARTY_PLUGIN }, {
			pianola: true,
		} as never);
	}

	it('numbers the setup walkthrough in the order the definition lists it', () => {
		renderDetails(pianolaExtension());

		const steps = screen.getByTestId('extension-usage-steps');
		const titles = PIANOLA_FIRST_PARTY_PLUGIN.usage!.steps!.map((s) => s.title);
		for (const title of titles) expect(steps.textContent).toContain(title);
		// Rendered as a real ordered list, so the numbering is the browser's.
		expect(steps.tagName).toBe('OL');
		expect(steps.querySelectorAll('li')).toHaveLength(titles.length);
	});

	it('states the guard rails before the user enables anything', () => {
		renderDetails(pianolaExtension());

		const notes = screen.getByTestId('extension-usage-notes').textContent ?? '';
		expect(notes).toContain('High-risk prompts ALWAYS escalate');
		expect(notes.toLowerCase()).toContain('no matching rule means escalate');
	});

	it('draws neither section for a guide that omits them', () => {
		// Concerto ships overview + access + agentCommands and no walkthrough.
		renderDetails(concertoExtension());

		expect(screen.queryByTestId('extension-usage-steps')).toBeNull();
		expect(screen.queryByTestId('extension-usage-notes')).toBeNull();
	});
});
