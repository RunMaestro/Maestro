/**
 * Tests for ModelsSettingsTab - the Models settings tab: the Overview landing
 * page and five panels (Library, Sources, System One, System Two, Gateway) that
 * the Settings sidebar draws as a subtree, over the existing sections, and the
 * nav that says which is open.
 *
 * Verifies each panel's sections, that each system panel lists exactly its own
 * tasks, that the Utility Agent sits under System Two, that Sources contains the
 * model server without cloud-only or download mirror sections, that the last
 * panel and Library section are remembered and a sub-tab path moves them, and
 * that opening the tab only reads what is on disk (nothing downloads or probes
 * on open).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	act,
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
	within,
} from '@testing-library/react';
import type { Theme } from '../../../../../renderer/types';
import {
	MODELS_SETTINGS_NAV_ITEMS,
	ModelsSettingsTab,
	useModelsSettingsNav,
	type ModelsSettingsNav,
} from '../../../../../renderer/components/Settings/tabs/LocalModelsTab';
import {
	MODELS_LIBRARY_SECTION_STORAGE_KEY,
	MODELS_SETTINGS_PANEL_STORAGE_KEY,
} from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/useModelsSettingsNav';
import { LOCAL_MODELS_SETTINGS } from '../../../../../renderer/components/Settings/searchableSettingsLocalModels';
import {
	MODELS_SETTINGS_PANELS,
	MODELS_SETTINGS_PANEL_LABELS,
} from '../../../../../shared/local-models/settings-location';
import { tasksForSystem } from '../../../../../shared/local-models/tasks';
import {
	PARAKEET_TDT_V2_ID,
	getLocalModel,
} from '../../../../../shared/local-models/model-catalog';
import { installLocalStorageMock } from '../../../../helpers/mockLocalStorage';

const theme = {
	colors: {
		accent: '#a78bfa',
		textMain: '#ffffff',
		textDim: '#888888',
		border: '#333333',
		bgMain: '#000000',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
} as unknown as Theme;

/**
 * Stands in for SettingsModal: owns the nav and draws one button per panel, the
 * way the sidebar's Models row (Overview) and its subtree do.
 */
function Harness({ onNav }: { onNav?: (nav: ModelsSettingsNav) => void }) {
	const nav = useModelsSettingsNav();
	onNav?.(nav);
	return (
		<>
			<button type="button" onClick={() => nav.setPanel('overview')}>
				Overview
			</button>
			{MODELS_SETTINGS_NAV_ITEMS.map((item) => (
				<button key={item.id} type="button" onClick={() => nav.setPanel(item.id)}>
					{item.label}
				</button>
			))}
			<ModelsSettingsTab theme={theme} nav={nav} />
		</>
	);
}

function openPanel(label: string) {
	fireEvent.click(screen.getByRole('button', { name: label }));
}

function openLibrarySection(label: string) {
	fireEvent.click(screen.getByRole('tab', { name: label }));
}

describe('ModelsSettingsTab', () => {
	beforeEach(() => {
		installLocalStorageMock();
	});

	it('names one sidebar row per detail panel, and opens on the Overview', () => {
		expect(MODELS_SETTINGS_NAV_ITEMS.map((item) => item.label)).toEqual(
			MODELS_SETTINGS_PANELS.filter((panel) => panel !== 'overview').map(
				(panel) => MODELS_SETTINGS_PANEL_LABELS[panel]
			)
		);
		render(<Harness />);
		expect(screen.getByTestId('models-settings-tab')).toHaveAttribute('data-panel', 'overview');
		expect(screen.getByTestId('models-overview')).toBeInTheDocument();
		// The Overview has no strip of its own.
		expect(screen.queryAllByRole('tab')).toEqual([]);
	});

	it('shows six stat tiles above the text, and a card per panel', async () => {
		render(<Harness />);
		const stats = screen.getByTestId('models-overview-stats');
		for (const label of [
			'On disk',
			'Installed',
			'Engines',
			'Active tasks',
			'Endpoints',
			'Memory',
		]) {
			expect(within(stats).getByText(label)).toBeInTheDocument();
		}
		// Nothing failed verification, so there is no tile or warning for it.
		expect(screen.queryByText('Needs attention')).toBeNull();
		expect(screen.queryByTestId('models-overview-needs-attention')).toBeNull();
		// The tiles come before the explanation.
		const intro = document.querySelector('[data-setting-id="local-models-overview"]')!;
		expect(stats.compareDocumentPosition(intro) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(intro).toHaveTextContent('active task');
		for (const panel of MODELS_SETTINGS_PANELS.filter((panel) => panel !== 'overview')) {
			expect(screen.getByTestId(`models-overview-panel-${panel}`)).toBeInTheDocument();
		}
		// Infrastructure fills the first row; the two systems share the second.
		const cards = screen.getAllByTestId(/^models-overview-panel-/);
		expect(cards.map((card) => card.getAttribute('aria-label'))).toEqual([
			'Open Library',
			'Open Sources',
			'Open Gateway',
			'Open System One',
			'Open System Two',
		]);
		expect(cards[0].parentElement).toHaveStyle({
			gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
		});
		for (const card of cards.slice(0, 3)) {
			expect(card).toHaveStyle({ gridColumn: 'span 2' });
		}
		for (const card of cards.slice(3)) {
			expect(card).toHaveStyle({ gridColumn: 'span 3' });
		}
		// The memory tile fills in once the hardware is read.
		await waitFor(() => expect(within(stats).queryByText('...')).toBeNull());
		// Opening the Overview reads; it downloads and probes nothing.
		expect(window.maestro.localModels.download).not.toHaveBeenCalled();
	});

	it('keeps Gateway on its own row in a narrow Overview', async () => {
		const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(480);
		try {
			render(<Harness />);
			const gateway = screen.getByRole('button', { name: 'Open Gateway' });
			expect(gateway.parentElement).toHaveStyle({
				gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
			});
			expect(gateway).toHaveStyle({ gridColumn: '1 / -1' });
			for (const panel of ['Library', 'Sources', 'System One', 'System Two']) {
				expect(screen.getByRole('button', { name: `Open ${panel}` })).toHaveStyle({
					gridColumn: 'span 2',
				});
			}
			await waitFor(() =>
				expect(within(screen.getByTestId('models-overview-stats')).queryByText('...')).toBeNull()
			);
		} finally {
			width.mockRestore();
		}
	});

	it('warns about a model that failed verification, and jumps to its section', async () => {
		const entry = getLocalModel(PARAKEET_TDT_V2_ID)!;
		vi.mocked(window.maestro.localModels.list).mockResolvedValueOnce([
			{
				entry,
				status: { id: entry.id, status: 'corrupt', manifest: null, bytesOnDisk: 1 },
				installPaths: [],
			},
		] as never);
		render(<Harness />);
		const warning = await screen.findByTestId('models-overview-needs-attention');
		expect(warning).toHaveTextContent(`${entry.displayName} failed verification`);

		fireEvent.click(warning);
		expect(screen.getByTestId('models-settings-tab')).toHaveAttribute('data-panel', 'library');
		expect(screen.getByRole('tab', { name: /^Speech/ })).toHaveAttribute('aria-selected', 'true');
		expect(screen.getByTestId('settings-models-library-tab-speech-error')).toBeInTheDocument();
	});

	it('jumps to a panel from its Overview card', () => {
		render(<Harness />);
		fireEvent.click(screen.getByRole('button', { name: 'Open Gateway' }));
		expect(screen.getByTestId('models-settings-tab')).toHaveAttribute('data-panel', 'gateway');

		openPanel('Overview');
		fireEvent.click(screen.getByRole('button', { name: 'Open Library' }));
		expect(screen.getByTestId('models-settings-tab')).toHaveAttribute('data-panel', 'library');
		// The section chips are gone: the Library's own strip picks the section.
		expect(screen.queryByTestId(/^models-overview-section-/)).toBeNull();
	});

	it('lists the Library sections with Engines first, and opens on Engines', () => {
		render(<Harness />);
		openPanel('Library');
		expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
			'Engines',
			'Agent Models',
			'Housekeeping',
			'Speech',
			'Search & Safety',
			'Custom',
		]);
		expect(screen.getByRole('tab', { name: 'Engines' })).toHaveAttribute('aria-selected', 'true');
		expect(screen.getByRole('tabpanel')).toHaveAttribute(
			'id',
			'settings-models-library-tabpanel-engines'
		);
	});

	it('shows each section on its own panel without cloud-only or advanced sections in Sources', () => {
		const { container } = render(<Harness />);
		const present = (id: string) => container.querySelector(`[data-setting-id="${id}"]`) !== null;

		openPanel('Library');
		expect(present('local-models-models')).toBe(true);
		expect(present('local-models-model-server')).toBe(false);
		expect(present('local-models-endpoints')).toBe(false);
		expect(present('local-models-download-source')).toBe(false);
		expect(screen.queryByTestId('local-models-cloud-only')).toBeNull();

		openPanel('Sources');
		expect(present('local-models-endpoints')).toBe(true);
		expect(present('local-models-voice-studio')).toBe(true);
		expect(window.maestro.voice.voiceStudioStatus).not.toHaveBeenCalled();
		expect(present('local-models-model-server')).toBe(true);
		expect(present('local-models-download-source')).toBe(false);
		expect(screen.queryByTestId('local-models-cloud-only')).toBeNull();
		expect(screen.queryByText('Advanced')).not.toBeInTheDocument();
		expect(present('local-models-models')).toBe(false);

		openPanel('Gateway');
		expect(present('local-models-gateway')).toBe(true);
		expect(screen.getByTestId('local-models-gateway-section')).toBeInTheDocument();
	});

	it('shows one Library section at a time', () => {
		const { container } = render(<Harness />);
		const present = (id: string) => container.querySelector(`[data-setting-id="${id}"]`) !== null;
		openPanel('Library');
		expect(present('local-models-engines')).toBe(true);
		expect(present('local-models-agents')).toBe(false);

		openLibrarySection('Agent Models');
		expect(present('local-models-agents')).toBe(true);
		expect(present('local-models-engines')).toBe(false);

		openLibrarySection('Custom');
		expect(present('local-models-add-hf')).toBe(true);
		expect(present('local-models-agents')).toBe(false);
	});

	it('lists only System One tasks on System One, with the semantic index card', () => {
		render(<Harness />);
		openPanel('System One');

		for (const task of tasksForSystem('one')) {
			expect(screen.getByTestId(`local-models-task-${task.id}`)).toBeInTheDocument();
		}
		for (const task of tasksForSystem('two')) {
			expect(screen.queryByTestId(`local-models-task-${task.id}`)).toBeNull();
		}
		expect(screen.getByTestId('semantic-index-settings')).toBeInTheDocument();
		expect(document.querySelector('[data-setting-id="local-models-utility-agent"]')).toBeNull();
	});

	it('puts the decision ledger under the System One tasks, and on no other inner tab', async () => {
		vi.mocked(window.maestro.localModels.systemOne.ledger).mockClear();
		const { container } = render(<Harness />);
		const ledger = () =>
			container.querySelector('[data-setting-id="local-models-system-one-ledger"]');
		expect(ledger()).toBeNull();
		expect(window.maestro.localModels.systemOne.ledger).not.toHaveBeenCalled();

		openPanel('System One');
		expect(ledger()).not.toBeNull();
		const tasks = container.querySelector('[data-setting-id="local-models-system-one"]')!;
		expect(
			tasks.compareDocumentPosition(ledger()!) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		// Opening the tab reads the ledger. It asks the engine nothing.
		expect(window.maestro.localModels.systemOne.ledger).toHaveBeenCalledWith({});
		expect(window.maestro.localModels.systemOne.test).not.toHaveBeenCalled();
		expect(await screen.findByTestId('system-one-ledger-empty')).toBeInTheDocument();

		openPanel('System Two');
		expect(ledger()).toBeNull();
	});

	it('puts System One for agents between the tasks and the ledger, and on no other inner tab', async () => {
		vi.mocked(window.maestro.localModels.systemOne.usage).mockClear();
		const { container } = render(<Harness />);
		const agents = () =>
			container.querySelector('[data-setting-id="local-models-system-one-agents"]');
		expect(agents()).toBeNull();
		expect(window.maestro.localModels.systemOne.usage).not.toHaveBeenCalled();

		openPanel('System One');
		expect(agents()).not.toBeNull();
		const tasks = container.querySelector('[data-setting-id="local-models-system-one"]')!;
		const ledger = container.querySelector('[data-setting-id="local-models-system-one-ledger"]')!;
		expect(
			tasks.compareDocumentPosition(agents()!) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		expect(
			agents()!.compareDocumentPosition(ledger) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		// Opening the tab reads the spend. It asks the engine nothing.
		expect(window.maestro.localModels.systemOne.usage).toHaveBeenCalledTimes(1);
		expect(window.maestro.localModels.systemOne.test).not.toHaveBeenCalled();
		// The switch reads the tab's one report: on by default.
		expect(
			await screen.findByRole('switch', { name: 'Let agents use System One' })
		).toHaveAttribute('aria-checked', 'true');

		openPanel('System Two');
		expect(agents()).toBeNull();
	});

	it('puts the engine card above the System One tasks, and on no other inner tab', async () => {
		const { container } = render(<Harness />);
		const engine = () =>
			container.querySelector('[data-setting-id="local-models-system-one-engine"]');
		expect(engine()).toBeNull();

		openPanel('System One');
		expect(engine()).not.toBeNull();
		const tasks = container.querySelector('[data-setting-id="local-models-system-one"]')!;
		expect(
			engine()!.compareDocumentPosition(tasks) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		// Opening the tab reads the report. It asks the engine nothing.
		expect(window.maestro.localModels.systemOne.report).toHaveBeenCalled();
		expect(window.maestro.localModels.systemOne.test).not.toHaveBeenCalled();

		// The fail policy column fills in from that one report.
		expect(await screen.findByTestId('local-models-task-fail-policy-cue-gate')).toHaveValue('open');

		openPanel('System Two');
		expect(engine()).toBeNull();
		expect(screen.queryByTestId('local-models-assignments-columns')).toBeNull();
	});

	it('lists only System Two tasks on System Two, with the Utility Agent above them', () => {
		render(<Harness />);
		openPanel('System Two');

		for (const task of tasksForSystem('two')) {
			expect(screen.getByTestId(`local-models-task-${task.id}`)).toBeInTheDocument();
		}
		for (const task of tasksForSystem('one')) {
			expect(screen.queryByTestId(`local-models-task-${task.id}`)).toBeNull();
		}
		expect(screen.queryByTestId('semantic-index-settings')).toBeNull();

		const assignments = screen.getByTestId('local-models-assignments-section-two');
		const utility = document.querySelector('[data-setting-id="local-models-utility-agent"]');
		expect(utility).not.toBeNull();
		// Configure the shared agent before choosing which tasks use it.
		expect(
			utility!.compareDocumentPosition(assignments) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		expect(utility).toHaveTextContent('Choose the default for tasks set to Utility source below.');
	});

	it('shows the tier defaults table on System Two, and on no other inner tab', () => {
		vi.mocked(window.maestro.localModels.tiers.options).mockClear();
		render(<Harness />);
		expect(document.querySelector('[data-setting-id="models-tier-defaults"]')).toBeNull();
		// Opening Library asks no harness what it can run.
		expect(window.maestro.localModels.tiers.options).not.toHaveBeenCalled();

		openPanel('System Two');

		const tiers = document.querySelector('[data-setting-id="models-tier-defaults"]');
		expect(tiers).not.toBeNull();
		expect(screen.getByTestId('tier-defaults-section')).toBeInTheDocument();
		// Tier defaults follow both the Utility Agent and the task assignments.
		const utility = document.querySelector('[data-setting-id="local-models-utility-agent"]');
		expect(
			utility!.compareDocumentPosition(tiers!) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});

	it('remembers the last panel and Library section across mounts', () => {
		const { unmount } = render(<Harness />);
		openPanel('Library');
		openLibrarySection('Speech');
		openPanel('Gateway');
		expect(localStorage.getItem(MODELS_SETTINGS_PANEL_STORAGE_KEY)).toBe('gateway');
		expect(localStorage.getItem(MODELS_LIBRARY_SECTION_STORAGE_KEY)).toBe('speech');
		unmount();

		render(<Harness />);
		expect(screen.getByTestId('models-settings-tab')).toHaveAttribute('data-panel', 'gateway');
		openPanel('Library');
		expect(screen.getByRole('tab', { name: 'Speech' })).toHaveAttribute('aria-selected', 'true');
	});

	it('falls back to the Overview and Engines when the stored places no longer exist', () => {
		localStorage.setItem(MODELS_SETTINGS_PANEL_STORAGE_KEY, 'assignments');
		localStorage.setItem(MODELS_LIBRARY_SECTION_STORAGE_KEY, 'judge');
		render(<Harness />);
		expect(screen.getByTestId('models-settings-tab')).toHaveAttribute('data-panel', 'overview');
		openPanel('Library');
		expect(screen.getByRole('tab', { name: 'Engines' })).toHaveAttribute('aria-selected', 'true');
	});

	it('renders every searchable-settings entry on the place it names', () => {
		let nav: ModelsSettingsNav | undefined;
		const { container } = render(<Harness onNav={(next) => (nav = next)} />);
		for (const entry of LOCAL_MODELS_SETTINGS) {
			expect(entry.tab).toBe('models');
			act(() => {
				expect(nav!.open(entry.subTab!)).toBe(true);
			});
			expect(
				container.querySelector(`[data-setting-id="${entry.id}"]`),
				`${entry.id} is not rendered on ${entry.subTab}`
			).not.toBeNull();
		}
	});

	describe('useModelsSettingsNav().open', () => {
		it('moves to a panel, or to Library and a section, and remembers both', () => {
			const { result } = renderHook(() => useModelsSettingsNav());
			act(() => {
				expect(result.current.open('system-two')).toBe(true);
			});
			expect(result.current.panel).toBe('system-two');
			expect(localStorage.getItem(MODELS_SETTINGS_PANEL_STORAGE_KEY)).toBe('system-two');

			act(() => {
				expect(result.current.open('library/engines')).toBe(true);
			});
			expect(result.current.panel).toBe('library');
			expect(result.current.librarySection).toBe('engines');
		});

		it('keeps the remembered section for a bare library', () => {
			localStorage.setItem(MODELS_LIBRARY_SECTION_STORAGE_KEY, 'custom');
			const { result } = renderHook(() => useModelsSettingsNav());
			act(() => {
				result.current.open('library');
			});
			expect(result.current.librarySection).toBe('custom');
		});

		it('moves nothing for a path that names no place', () => {
			localStorage.setItem(MODELS_SETTINGS_PANEL_STORAGE_KEY, 'sources');
			const { result } = renderHook(() => useModelsSettingsNav());
			act(() => {
				expect(result.current.open('assignments')).toBe(false);
				expect(result.current.open('library/judge')).toBe(false);
			});
			expect(result.current.panel).toBe('sources');
		});
	});

	it('downloads nothing when the tab opens', () => {
		render(<Harness />);
		expect(window.maestro.localModels.download).not.toHaveBeenCalled();
	});
});
