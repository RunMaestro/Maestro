// Source: src/__tests__/renderer/components/History/UserSourceFilter.test.tsx
// Source: src/__tests__/renderer/components/History/historyFilterPersistence.test.ts
// Source: src/__tests__/renderer/components/History/HistoryFilterToggle.test.tsx
// Source: src/__tests__/renderer/components/History/historyRowHeight.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { UserSourceFilter } from '../../../../renderer/components/History';
import { DESKTOP_USER_KEY } from '../../../../renderer/components/History';
import { mockTheme } from '../../../helpers/mockTheme';
import { beforeEach } from 'vitest';
import type { HistoryEntryType } from '../../../../renderer/types';
import { HISTORY_PANEL_FILTERS_KEY } from '../../../../renderer/components/History';
import { historyPanelFilterKeyForAgent } from '../../../../renderer/components/History';
import { loadPersistedHistoryFilters } from '../../../../renderer/components/History';
import { savePersistedHistoryFilters } from '../../../../renderer/components/History';
import { resolveInitialHistoryFilters } from '../../../../renderer/components/History';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
import React from 'react';
import { HistoryFilterToggle } from '../../../../renderer/components/History';
import { ALL_HISTORY_ENTRY_TYPES } from '../../../../shared/history';
import { RIGHT_PANEL_PILL_FONT_SIZE } from '../../../../renderer/constants/rightPanel';
import { RIGHT_PANEL_TAB_FONT_SIZE } from '../../../../renderer/constants/rightPanel';
import { afterEach } from 'vitest';
import { HistoryEntryItem } from '../../../../renderer/components/History';
import { estimateHistoryRowHeight } from '../../../../renderer/components/History';
import { ESTIMATED_ROW_HEIGHT_BASE } from '../../../../renderer/components/History';
import { ESTIMATED_ROW_HEIGHT_FOOTER } from '../../../../renderer/components/History';
import { ESTIMATED_ROW_HEIGHT_CUE_SUBTITLE } from '../../../../renderer/components/History';
import type { HistoryEntry } from '../../../../renderer/types';
describeSourceSuite('UserSourceFilter', () => {
	const counts = new Map<string, number>([
		[DESKTOP_USER_KEY, 3],
		['pedram', 2],
	]);

	const labels = new Map<string, string>([['pedram', 'Pedram A']]);

	describe('UserSourceFilter', () => {
		it('shows "All Senders" with no count when nothing is selected', () => {
			render(
				<UserSourceFilter
					userCounts={counts}
					userLabels={labels}
					selectedUser={null}
					onSelect={vi.fn()}
					theme={mockTheme}
				/>
			);

			expect(screen.getByText('All Senders')).toBeInTheDocument();
		});

		it('labels the desktop key rather than leaking the sentinel', () => {
			render(
				<UserSourceFilter
					userCounts={counts}
					userLabels={labels}
					selectedUser={null}
					onSelect={vi.fn()}
					theme={mockTheme}
				/>
			);

			fireEvent.click(screen.getByText('All Senders'));

			expect(screen.getByText('Desktop (3)')).toBeInTheDocument();
			expect(screen.queryByText(new RegExp(DESKTOP_USER_KEY))).not.toBeInTheDocument();
		});

		it('reports the username, not the display name, when an account is picked', () => {
			const onSelect = vi.fn();
			render(
				<UserSourceFilter
					userCounts={counts}
					userLabels={labels}
					selectedUser={null}
					onSelect={onSelect}
					theme={mockTheme}
				/>
			);

			fireEvent.click(screen.getByText('All Senders'));
			fireEvent.click(screen.getByText('Pedram A (2)'));

			expect(onSelect).toHaveBeenCalledWith('pedram');
		});

		it('falls back to the username when the account has no display label', () => {
			render(
				<UserSourceFilter
					userCounts={counts}
					selectedUser="pedram"
					onSelect={vi.fn()}
					theme={mockTheme}
				/>
			);

			expect(screen.getByText('pedram (2)')).toBeInTheDocument();
		});

		it('clears the filter from the "All Senders" row', () => {
			const onSelect = vi.fn();
			render(
				<UserSourceFilter
					userCounts={counts}
					userLabels={labels}
					selectedUser="pedram"
					onSelect={onSelect}
					theme={mockTheme}
				/>
			);

			fireEvent.click(screen.getByText('Pedram A (2)'));
			fireEvent.click(screen.getByText('All Senders'));

			expect(onSelect).toHaveBeenCalledWith(null);
		});
	});
});
describeSourceSuite('historyFilterPersistence', () => {
	const AGENT_A = 'agent-a';
	const AGENT_B = 'agent-b';

	describe('historyFilterPersistence', () => {
		beforeEach(() => {
			// jsdom here doesn't provide a working Storage; install a fresh
			// in-memory mock each test (doubles as a per-test reset).
			installLocalStorageMock();
		});

		describe('historyPanelFilterKeyForAgent', () => {
			it('namespaces the panel key by agent id', () => {
				expect(historyPanelFilterKeyForAgent(AGENT_A)).toBe(
					`${HISTORY_PANEL_FILTERS_KEY}.${AGENT_A}`
				);
			});

			it('produces a distinct key per agent', () => {
				expect(historyPanelFilterKeyForAgent(AGENT_A)).not.toBe(
					historyPanelFilterKeyForAgent(AGENT_B)
				);
			});
		});

		describe('save/load round trip', () => {
			it('persists and restores a selection under a per-agent key', () => {
				const key = historyPanelFilterKeyForAgent(AGENT_A);
				savePersistedHistoryFilters(key, new Set<HistoryEntryType>(['USER']));
				expect(loadPersistedHistoryFilters(key)).toEqual(new Set(['USER']));
			});

			it('keeps each agent independent', () => {
				savePersistedHistoryFilters(
					historyPanelFilterKeyForAgent(AGENT_A),
					new Set<HistoryEntryType>(['USER'])
				);
				savePersistedHistoryFilters(
					historyPanelFilterKeyForAgent(AGENT_B),
					new Set<HistoryEntryType>(['AUTO', 'CUE'])
				);
				expect(loadPersistedHistoryFilters(historyPanelFilterKeyForAgent(AGENT_A))).toEqual(
					new Set(['USER'])
				);
				expect(loadPersistedHistoryFilters(historyPanelFilterKeyForAgent(AGENT_B))).toEqual(
					new Set(['AUTO', 'CUE'])
				);
			});

			it('treats an empty set as a valid stored choice, distinct from null', () => {
				const key = historyPanelFilterKeyForAgent(AGENT_A);
				expect(loadPersistedHistoryFilters(key)).toBeNull();
				savePersistedHistoryFilters(key, new Set<HistoryEntryType>());
				expect(loadPersistedHistoryFilters(key)).toEqual(new Set());
			});
		});

		describe('resolveInitialHistoryFilters', () => {
			it('defaults to all-on (incl. CUE and AGENT) when nothing is stored and Cue is enabled', () => {
				const key = historyPanelFilterKeyForAgent(AGENT_A);
				expect(resolveInitialHistoryFilters(key, true)).toEqual(
					new Set(['USER', 'AGENT', 'RELAY', 'AUTO', 'CUE'])
				);
			});

			it('strips CUE when the Cue feature is off', () => {
				const key = historyPanelFilterKeyForAgent(AGENT_A);
				savePersistedHistoryFilters(key, new Set<HistoryEntryType>(['USER', 'AUTO', 'CUE']));
				expect(resolveInitialHistoryFilters(key, false)).toEqual(new Set(['USER', 'AUTO']));
			});

			it('switches AGENT on when upgrading a legacy (pre-AGENT) stored selection', () => {
				// A bare array is the pre-v2 payload. It predates the AGENT type, so it
				// cannot have opted out of it - hydrating verbatim would silently hide
				// every consult entry.
				const key = historyPanelFilterKeyForAgent(AGENT_A);
				localStorage.setItem(key, JSON.stringify(['USER', 'AUTO']));
				expect(resolveInitialHistoryFilters(key, true)).toEqual(
					new Set(['USER', 'AUTO', 'AGENT', 'RELAY'])
				);
			});

			it('switches Relay on for a saved filter selection from before Relay existed', () => {
				const key = historyPanelFilterKeyForAgent(AGENT_A);
				localStorage.setItem(key, JSON.stringify({ v: 2, filters: ['USER', 'AUTO'] }));
				expect(resolveInitialHistoryFilters(key, true)).toEqual(new Set(['USER', 'AUTO', 'RELAY']));
			});

			it.each([undefined, null, '2', 'unknown'])(
				'upgrades an unversioned or invalid legacy version %s without hiding Relay',
				(v) => {
					const key = historyPanelFilterKeyForAgent(AGENT_A);
					localStorage.setItem(key, JSON.stringify({ v, filters: ['USER', 'AUTO'] }));
					expect(resolveInitialHistoryFilters(key, true)).toEqual(
						new Set(['USER', 'AUTO', 'RELAY'])
					);
				}
			);

			it('honors an explicit AGENT deselection saved in the current format', () => {
				const key = historyPanelFilterKeyForAgent(AGENT_A);
				savePersistedHistoryFilters(key, new Set<HistoryEntryType>(['USER', 'AUTO']));
				expect(resolveInitialHistoryFilters(key, true)).toEqual(new Set(['USER', 'AUTO']));
			});

			it('hydrates the per-agent selection over the default', () => {
				const key = historyPanelFilterKeyForAgent(AGENT_A);
				savePersistedHistoryFilters(key, new Set<HistoryEntryType>(['AUTO']));
				expect(resolveInitialHistoryFilters(key, true)).toEqual(new Set(['AUTO']));
			});

			it('falls back to the legacy global key the first time an agent is resolved', () => {
				// Simulate a pre-upgrade user who had a global selection saved.
				savePersistedHistoryFilters(HISTORY_PANEL_FILTERS_KEY, new Set<HistoryEntryType>(['USER']));
				const key = historyPanelFilterKeyForAgent(AGENT_A);
				expect(resolveInitialHistoryFilters(key, true, HISTORY_PANEL_FILTERS_KEY)).toEqual(
					new Set(['USER'])
				);
			});

			it('prefers the per-agent selection over the fallback key when both exist', () => {
				savePersistedHistoryFilters(HISTORY_PANEL_FILTERS_KEY, new Set<HistoryEntryType>(['USER']));
				const key = historyPanelFilterKeyForAgent(AGENT_A);
				savePersistedHistoryFilters(key, new Set<HistoryEntryType>(['AUTO']));
				expect(resolveInitialHistoryFilters(key, true, HISTORY_PANEL_FILTERS_KEY)).toEqual(
					new Set(['AUTO'])
				);
			});

			it('respects an empty per-agent set rather than falling back', () => {
				savePersistedHistoryFilters(HISTORY_PANEL_FILTERS_KEY, new Set<HistoryEntryType>(['USER']));
				const key = historyPanelFilterKeyForAgent(AGENT_A);
				savePersistedHistoryFilters(key, new Set<HistoryEntryType>());
				expect(resolveInitialHistoryFilters(key, true, HISTORY_PANEL_FILTERS_KEY)).toEqual(
					new Set()
				);
			});
		});
	});
});
describeSourceSuite('HistoryFilterToggle', () => {
	// Create mock theme

	describe('HistoryFilterToggle', () => {
		it('renders AUTO and USER filter buttons', () => {
			render(
				<HistoryFilterToggle
					activeFilters={new Set<HistoryEntryType>(['AUTO', 'USER'])}
					onToggleFilter={vi.fn()}
					theme={mockTheme}
				/>
			);
			expect(screen.getByText('AUTO')).toBeInTheDocument();
			expect(screen.getByText('USER')).toBeInTheDocument();
		});

		it('calls onToggleFilter with AUTO when AUTO button is clicked', () => {
			const onToggleFilter = vi.fn();
			render(
				<HistoryFilterToggle
					activeFilters={new Set<HistoryEntryType>(['AUTO', 'USER'])}
					onToggleFilter={onToggleFilter}
					theme={mockTheme}
				/>
			);
			fireEvent.click(screen.getByText('AUTO'));
			expect(onToggleFilter).toHaveBeenCalledWith('AUTO');
		});

		it('calls onToggleFilter with USER when USER button is clicked', () => {
			const onToggleFilter = vi.fn();
			render(
				<HistoryFilterToggle
					activeFilters={new Set<HistoryEntryType>(['AUTO', 'USER'])}
					onToggleFilter={onToggleFilter}
					theme={mockTheme}
				/>
			);
			fireEvent.click(screen.getByText('USER'));
			expect(onToggleFilter).toHaveBeenCalledWith('USER');
		});

		it('shows full opacity for active filters', () => {
			render(
				<HistoryFilterToggle
					activeFilters={new Set<HistoryEntryType>(['AUTO', 'USER'])}
					onToggleFilter={vi.fn()}
					theme={mockTheme}
				/>
			);
			const autoButton = screen.getByText('AUTO').closest('button')!;
			const userButton = screen.getByText('USER').closest('button')!;

			expect(autoButton.className).toContain('opacity-100');
			expect(userButton.className).toContain('opacity-100');
		});

		it('shows reduced opacity for inactive filters', () => {
			render(
				<HistoryFilterToggle
					activeFilters={new Set<HistoryEntryType>(['USER'])}
					onToggleFilter={vi.fn()}
					theme={mockTheme}
				/>
			);
			const autoButton = screen.getByText('AUTO').closest('button')!;
			const userButton = screen.getByText('USER').closest('button')!;

			// AUTO should be inactive (opacity-40)
			expect(autoButton.className).toContain('opacity-40');
			// USER should be active (opacity-100)
			expect(userButton.className).toContain('opacity-100');
		});

		it('styles active AUTO button with warning colors', () => {
			render(
				<HistoryFilterToggle
					activeFilters={new Set<HistoryEntryType>(['AUTO'])}
					onToggleFilter={vi.fn()}
					theme={mockTheme}
				/>
			);
			const autoButton = screen.getByText('AUTO').closest('button')!;
			expect(autoButton).toHaveStyle({ color: mockTheme.colors.warning });
		});

		it('styles active USER button with accent colors', () => {
			render(
				<HistoryFilterToggle
					activeFilters={new Set<HistoryEntryType>(['USER'])}
					onToggleFilter={vi.fn()}
					theme={mockTheme}
				/>
			);
			const userButton = screen.getByText('USER').closest('button')!;
			expect(userButton).toHaveStyle({ color: mockTheme.colors.accent });
		});

		it('styles inactive buttons with textDim color', () => {
			render(
				<HistoryFilterToggle
					activeFilters={new Set<HistoryEntryType>([])}
					onToggleFilter={vi.fn()}
					theme={mockTheme}
				/>
			);
			const autoButton = screen.getByText('AUTO').closest('button')!;
			const userButton = screen.getByText('USER').closest('button')!;

			expect(autoButton).toHaveStyle({ color: mockTheme.colors.textDim });
			expect(userButton).toHaveStyle({ color: mockTheme.colors.textDim });
		});

		it('renders all three buttons even when no filters are active', () => {
			render(
				<HistoryFilterToggle
					activeFilters={new Set<HistoryEntryType>([])}
					onToggleFilter={vi.fn()}
					theme={mockTheme}
				/>
			);
			expect(screen.getByText('AUTO')).toBeInTheDocument();
			expect(screen.getByText('USER')).toBeInTheDocument();
			expect(screen.getByText('CUE')).toBeInTheDocument();
		});

		it('hides CUE button when visibleTypes excludes it', () => {
			render(
				<HistoryFilterToggle
					activeFilters={new Set<HistoryEntryType>(['AUTO', 'USER'])}
					onToggleFilter={vi.fn()}
					theme={mockTheme}
					visibleTypes={['AUTO', 'USER']}
				/>
			);
			expect(screen.getByText('AUTO')).toBeInTheDocument();
			expect(screen.getByText('USER')).toBeInTheDocument();
			expect(screen.queryByText('CUE')).not.toBeInTheDocument();
		});

		it('shows CUE button when visibleTypes includes it', () => {
			render(
				<HistoryFilterToggle
					activeFilters={new Set<HistoryEntryType>(['AUTO', 'USER', 'CUE'])}
					onToggleFilter={vi.fn()}
					theme={mockTheme}
					visibleTypes={['AUTO', 'USER', 'CUE']}
				/>
			);
			expect(screen.getByText('AUTO')).toBeInTheDocument();
			expect(screen.getByText('USER')).toBeInTheDocument();
			expect(screen.getByText('CUE')).toBeInTheDocument();
		});

		it('renders CUE filter button', () => {
			render(
				<HistoryFilterToggle
					activeFilters={new Set<HistoryEntryType>(['AUTO', 'USER', 'CUE'])}
					onToggleFilter={vi.fn()}
					theme={mockTheme}
				/>
			);
			expect(screen.getByText('CUE')).toBeInTheDocument();
		});

		it('calls onToggleFilter with CUE when CUE button is clicked', () => {
			const onToggleFilter = vi.fn();
			render(
				<HistoryFilterToggle
					activeFilters={new Set<HistoryEntryType>(['AUTO', 'USER', 'CUE'])}
					onToggleFilter={onToggleFilter}
					theme={mockTheme}
				/>
			);
			fireEvent.click(screen.getByText('CUE'));
			expect(onToggleFilter).toHaveBeenCalledWith('CUE');
		});

		it('styles active CUE button with teal colors', () => {
			render(
				<HistoryFilterToggle
					activeFilters={new Set<HistoryEntryType>(['CUE'])}
					onToggleFilter={vi.fn()}
					theme={mockTheme}
				/>
			);
			const cueButton = screen.getByText('CUE').closest('button')!;
			expect(cueButton).toHaveStyle({ color: '#06b6d4' });
		});

		it('shows CUE button as inactive when not in active filters', () => {
			render(
				<HistoryFilterToggle
					activeFilters={new Set<HistoryEntryType>(['AUTO', 'USER'])}
					onToggleFilter={vi.fn()}
					theme={mockTheme}
				/>
			);
			const cueButton = screen.getByText('CUE').closest('button')!;
			expect(cueButton.className).toContain('opacity-40');
		});

		it('renders pill icons by default', () => {
			const { container } = render(
				<HistoryFilterToggle
					activeFilters={new Set<HistoryEntryType>(['AUTO', 'USER', 'CUE', 'AGENT'])}
					onToggleFilter={vi.fn()}
					theme={mockTheme}
				/>
			);
			// One pill per entry type, each with an SVG icon when not compact.
			expect(container.querySelectorAll('button svg').length).toBe(ALL_HISTORY_ENTRY_TYPES.length);
		});

		it('renders a pill for the AGENT type', () => {
			const onToggleFilter = vi.fn();
			render(
				<HistoryFilterToggle
					activeFilters={new Set<HistoryEntryType>(['AGENT'])}
					onToggleFilter={onToggleFilter}
					theme={mockTheme}
				/>
			);
			expect(screen.getByText('AGENT')).toBeInTheDocument();
			fireEvent.click(screen.getByText('AGENT'));
			expect(onToggleFilter).toHaveBeenCalledWith('AGENT');
		});

		it('hides pill icons when compact', () => {
			const { container } = render(
				<HistoryFilterToggle
					activeFilters={new Set<HistoryEntryType>(['AUTO', 'USER', 'CUE', 'AGENT'])}
					onToggleFilter={vi.fn()}
					theme={mockTheme}
					compact
				/>
			);
			expect(container.querySelectorAll('button svg').length).toBe(0);
			// Labels still render so the controls remain usable in narrow panels.
			expect(screen.getByText('AUTO')).toBeInTheDocument();
			expect(screen.getByText('USER')).toBeInTheDocument();
			expect(screen.getByText('CUE')).toBeInTheDocument();
		});
		describe('fillWidth', () => {
			/**
			 * The pills share their toolbar row with the search and help buttons. The
			 * row neither wraps nor scrolls, and nothing in it used to shrink, so once
			 * the pills outgrew the space the overflow spilled out of both ends of a
			 * centred row and took the two buttons with it.
			 */
			it('stays its natural width so the flanking controls sit beside the pills', () => {
				// `flex-1` would make the row swallow the whole toolbar and strand the
				// search and help buttons against the two panel edges. The row only
				// needs to KNOW the free width, not occupy it.
				const { container } = render(
					<HistoryFilterToggle
						activeFilters={new Set<HistoryEntryType>(['AUTO'])}
						onToggleFilter={vi.fn()}
						theme={mockTheme}
						fillWidth
					/>
				);
				const row = container.querySelector('[data-testid="history-filter-toggle"]')!;
				expect(row.className).not.toContain('flex-1');
			});

			it('may still shrink, so a squeeze clips a pill instead of a button', () => {
				// min-w-0 with flex-shrink left at its default. Without min-w-0 a flex
				// item refuses to go below its content and pushes its neighbours out
				// instead, which is the original bug.
				const { container } = render(
					<HistoryFilterToggle
						activeFilters={new Set<HistoryEntryType>(['AUTO'])}
						onToggleFilter={vi.fn()}
						theme={mockTheme}
						fillWidth
					/>
				);
				const row = container.querySelector('[data-testid="history-filter-toggle"]')!;
				expect(row.className).toContain('min-w-0');
				expect(row.className).not.toContain('flex-shrink-0');
				expect(row.className).toContain('overflow-hidden');
			});

			it('measures the labels off to one side, not the live pills', () => {
				// Measuring the rendered pills would feed each density choice into the
				// next one and oscillate. The mirror is fixed at the base size, so its
				// width is a property of the font rather than of the current rung.
				const { container } = render(
					<HistoryFilterToggle
						activeFilters={new Set<HistoryEntryType>(['AUTO'])}
						onToggleFilter={vi.fn()}
						theme={mockTheme}
						visibleTypes={['USER', 'AGENT', 'AUTO', 'CUE']}
						fillWidth
					/>
				);
				const mirror = container.querySelector<HTMLElement>(
					'[data-testid="history-filter-pill-mirror"]'
				)!;
				expect(mirror.textContent).toBe('USERAGENTAUTOCUE');
				expect(mirror.style.visibility).toBe('hidden');
				expect(mirror.getAttribute('aria-hidden')).toBe('true');
				expect(mirror.className).toContain('absolute');
			});

			it('opts out entirely when the toolbar has no free width to read', () => {
				// Director's Notes puts the pills beside an activity graph that already
				// consumes the leftover space, so there is no free figure to measure.
				const { container } = render(
					<HistoryFilterToggle
						activeFilters={new Set<HistoryEntryType>(['AUTO'])}
						onToggleFilter={vi.fn()}
						theme={mockTheme}
					/>
				);
				const row = container.querySelector('[data-testid="history-filter-toggle"]')!;
				expect(row.className).toContain('flex-shrink-0');
				expect(container.querySelector('[data-testid="history-filter-pill-mirror"]')).toBeNull();
			});
		});

		describe('type scale', () => {
			/**
			 * These pills sit beside the search button and the activity graph as
			 * secondary chrome. `text-xs` was tuned when the root font was always 14px
			 * monospace; the root is now the interface font size, which under the
			 * Default preset is a proportional face at 15px - bigger, and with much
			 * wider uppercase glyphs per em. Left alone they read as a headline in a
			 * row of controls.
			 */
			function pill(): HTMLElement {
				render(
					<HistoryFilterToggle
						activeFilters={new Set<HistoryEntryType>(['AUTO'])}
						onToggleFilter={vi.fn()}
						theme={mockTheme}
					/>
				);
				return screen.getByText('AUTO');
			}

			it('uses the pill size', () => {
				expect(pill().style.fontSize).toBe(RIGHT_PANEL_PILL_FONT_SIZE);
			});

			it('stays smaller than the tab heading above it', () => {
				// These are controls labelling the rows beneath them, not a heading.
				expect(parseFloat(RIGHT_PANEL_PILL_FONT_SIZE)).toBeLessThan(
					parseFloat(RIGHT_PANEL_TAB_FONT_SIZE)
				);
			});

			it('stays below the 10px entry rows it labels', () => {
				// The pills are rem-based and grow with the interface font and zoom,
				// while the History entries beneath them are pinned at an absolute
				// text-[10px]. At a 16px interface font with a 1.2 zoom the chrome was
				// rendering near 14px against 10px content.
				const rem = parseFloat(RIGHT_PANEL_PILL_FONT_SIZE);
				expect(rem).toBeLessThan(0.625); // 10px at a 16px root
			});

			it('sizes in rem, so the pills still scale with Cmd+=', () => {
				// A pixel literal would freeze them at one zoom level while everything
				// around them grew, which is the same class of bug in reverse.
				const style = pill().style;
				expect(style.fontSize).toBeTruthy();
				expect(style.fontSize.endsWith('rem')).toBe(true);
				expect(style.lineHeight.endsWith('rem')).toBe(true);
			});

			it('restates the line-height text-xs used to supply', () => {
				// Dropping the class drops its line-height too; without this the pill
				// would resize to whatever line-height it happened to inherit.
				expect(pill().style.lineHeight).toBe('1rem');
			});

			it('keeps the uppercase bold treatment', () => {
				const button = pill();
				expect(button.className).toContain('uppercase');
				expect(button.className).toContain('font-bold');
			});
		});
	});
});
describeSourceSuite('historyRowHeight', () => {
	/**
	 * Row-height estimation for CUE rows now that they are served from `cue_events`
	 * rather than the agent's JSONL file (CUE-HISTORY-02).
	 *
	 * `estimateHistoryRowHeight` decides a row's height from a handful of fields,
	 * but the row's ACTUAL height is decided by `HistoryEntryItem`'s own render
	 * conditions. The two are separate predicates over the same entry, so they can
	 * drift - and when the estimate comes in UNDER the render, adjacent rows
	 * overlap for the frame between the initial paint and the ResizeObserver
	 * correction. These tests pin them together: each case renders the entry and
	 * derives the expected height from what actually landed in the DOM.
	 */

	/**
	 * The three shapes a DB-sourced CUE row can take, mirroring
	 * `cueEventToHistoryEntry()` in `src/main/cue/stats/cue-stats-query.ts`:
	 *
	 * - `cueEventType` is always set (`cue_events.type` is NOT NULL).
	 * - `elapsedTimeMs` is set only when `completed_at` is non-NULL, so an orphaned
	 *   `running` row - served as a failure - carries no footer at all. That is the
	 *   one variant the JSONL writer effectively never produced.
	 * - `usageStats`, `achievementAction`, `hostname` and `tokenSource` are never
	 *   set on a Cue row from either writer, so the footer hangs on `elapsedTimeMs`
	 *   alone.
	 */
	const cueRow = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
		id: 'cue-event-1',
		type: 'CUE',
		timestamp: Date.now(),
		summary: 'Ran the lint sweep and fixed 3 files',
		fullResponse: 'full output',
		projectPath: '/test/project',
		sessionId: 'agent-1',
		sessionName: 'Maestro',
		success: true,
		elapsedTimeMs: 4200,
		cueTriggerName: 'lint-on-save',
		cueEventType: 'file.changed',
		...overrides,
	});

	/** Height the DOM actually implies, read back from the rendered row. */
	function renderedHeightTerms(entry: HistoryEntry): number {
		const { container, unmount } = render(
			<HistoryEntryItem
				entry={entry}
				index={0}
				isSelected={false}
				theme={mockTheme}
				onOpenDetailModal={vi.fn()}
			/>
		);
		const hasFooter = container.querySelector('.border-t') !== null;
		// The tally line of a grouped row replaces the "Triggered by:" subtitle and
		// occupies the same slot, so either one counts as the subtitle term.
		const subtitleText = container.textContent ?? '';
		const hasCueSubtitle =
			subtitleText.includes('Triggered by:') ||
			container.querySelector('[data-cue-group]') !== null;
		unmount();

		return (
			ESTIMATED_ROW_HEIGHT_BASE +
			(hasFooter ? ESTIMATED_ROW_HEIGHT_FOOTER : 0) +
			(hasCueSubtitle ? ESTIMATED_ROW_HEIGHT_CUE_SUBTITLE : 0)
		);
	}

	describe('estimateHistoryRowHeight for DB-sourced CUE rows', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('matches the rendered row for a completed run with output', () => {
			const entry = cueRow();
			expect(estimateHistoryRowHeight(entry)).toBe(renderedHeightTerms(entry));
			expect(estimateHistoryRowHeight(entry)).toBe(
				ESTIMATED_ROW_HEIGHT_BASE + ESTIMATED_ROW_HEIGHT_FOOTER + ESTIMATED_ROW_HEIGHT_CUE_SUBTITLE
			);
		});

		it('matches the rendered row for a failed run', () => {
			const entry = cueRow({ success: false, summary: 'Cue run failed: exit 1' });
			expect(estimateHistoryRowHeight(entry)).toBe(renderedHeightTerms(entry));
		});

		it('drops the footer for a run with no completion time', () => {
			// `completed_at` NULL -> no `elapsedTimeMs` -> no footer row, but the
			// "Triggered by:" subtitle still renders.
			const entry = cueRow({ elapsedTimeMs: undefined });
			expect(estimateHistoryRowHeight(entry)).toBe(renderedHeightTerms(entry));
			expect(estimateHistoryRowHeight(entry)).toBe(
				ESTIMATED_ROW_HEIGHT_BASE + ESTIMATED_ROW_HEIGHT_CUE_SUBTITLE
			);
		});

		it('charges the CUE subtitle for every Cue event type the DB can serve', () => {
			// `cue_events.type` is NOT NULL, so the subtitle is unconditional for a
			// DB row regardless of whether the renderer knows how to humanize the
			// value - an unrecognized type still renders the line.
			for (const cueEventType of [
				'file.changed',
				'agent.completed',
				'time.interval',
				'github.pr',
				'some.future.trigger',
			]) {
				const entry = cueRow({ cueEventType });
				expect(estimateHistoryRowHeight(entry)).toBe(renderedHeightTerms(entry));
			}
		});

		it('matches the rendered row for a collapsed Cue group', () => {
			// The group's tally line sits exactly where the "Triggered by:" subtitle
			// would, so a grouped row costs the same single extra line.
			const entry = cueRow({
				cueGroup: { key: 'Command-Bus', label: 'Command-Bus', runCount: 1382, failureCount: 3 },
			});
			expect(estimateHistoryRowHeight(entry)).toBe(renderedHeightTerms(entry));
			expect(estimateHistoryRowHeight(entry)).toBe(
				ESTIMATED_ROW_HEIGHT_BASE + ESTIMATED_ROW_HEIGHT_FOOTER + ESTIMATED_ROW_HEIGHT_CUE_SUBTITLE
			);
		});

		it('charges the tally line for a group whose row carries no cueEventType', () => {
			// A grouped row renders its tally whether or not the trigger type is
			// known, so the subtitle term can no longer hang on `cueEventType` alone.
			const entry = cueRow({
				cueEventType: undefined,
				cueGroup: { key: 'Command-Bus', label: 'Command-Bus', runCount: 12, failureCount: 0 },
			});
			expect(estimateHistoryRowHeight(entry)).toBe(renderedHeightTerms(entry));
			expect(estimateHistoryRowHeight(entry)).toBe(
				ESTIMATED_ROW_HEIGHT_BASE + ESTIMATED_ROW_HEIGHT_FOOTER + ESTIMATED_ROW_HEIGHT_CUE_SUBTITLE
			);
		});

		it('never under-estimates a USER row, which carries no CUE subtitle', () => {
			// Guards the other direction: the subtitle term must stay CUE-only, or
			// every USER/AUTO row would be over-estimated by 18px and leave a gap.
			const entry: HistoryEntry = {
				id: 'user-1',
				type: 'USER',
				timestamp: Date.now(),
				summary: 'Asked a question',
				projectPath: '/test/project',
				elapsedTimeMs: 1200,
			};
			expect(estimateHistoryRowHeight(entry)).toBe(renderedHeightTerms(entry));
			expect(estimateHistoryRowHeight(entry)).toBe(
				ESTIMATED_ROW_HEIGHT_BASE + ESTIMATED_ROW_HEIGHT_FOOTER
			);
		});

		it('charges the footer for a row whose only footer content is the sender pill', () => {
			// The Web Login sender pill lives in the footer, so a turn a browser
			// sent opens the footer row on its own - exactly like the hostname pill.
			// Missing that term under-estimates the row and overlaps the next one.
			const entry: HistoryEntry = {
				id: 'web-1',
				type: 'USER',
				timestamp: Date.now(),
				summary: 'Asked from a phone',
				projectPath: '/test/project',
				userName: 'pedram',
				userDisplayName: 'Pedram A',
			};
			expect(estimateHistoryRowHeight(entry)).toBe(renderedHeightTerms(entry));
			expect(estimateHistoryRowHeight(entry)).toBe(
				ESTIMATED_ROW_HEIGHT_BASE + ESTIMATED_ROW_HEIGHT_FOOTER
			);
		});
	});
});
