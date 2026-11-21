// Source: src/__tests__/renderer/components/HarnessInteractionPrompt.test.tsx
// Source: src/__tests__/renderer/components/CrossTabSearchModal.test.tsx
// Source: src/__tests__/renderer/components/CsvTableRenderer.test.tsx
// Source: src/__tests__/renderer/components/SnoozeTabModal.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { afterEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { HarnessInteractionPrompt } from '../../../renderer/components/HarnessInteractionPrompt/HarnessInteractionPrompt';
import { useHarnessInteractionStore } from '../../../renderer/stores/harnessInteractionStore';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { HarnessInteractionRequest } from '../../../shared/harness-control/types';
import { mockTheme } from '../../helpers/mockTheme';
import React from 'react';
import { beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { CrossTabSearchModal } from '../../../renderer/components/CrossTabSearchModal';
import { MOUNT_FOCUS_DELAY_MS } from '../../../renderer/hooks/utils/useFocusAfterRender';
import { createMockAITab } from '../../helpers';
import type { AITab } from '../../../renderer/types';
import type { LogEntry } from '../../../renderer/types';
import { waitFor } from '@testing-library/react';
import { CsvTableRenderer } from '../../../renderer/components/CsvTableRenderer';
import { restorePointer } from '../../helpers/mockPointer';
import { setCoarsePointer } from '../../helpers/mockPointer';
import { SnoozeTabModal } from '../../../renderer/components/SnoozeTabModal';
describeSourceSuite('HarnessInteractionPrompt', () => {
	const optionalRequest: HarnessInteractionRequest = {
		requestId: 'request-optional',
		sessionId: 'session-a',
		spawnGeneration: 1,
		kind: 'elicitation',
		provider: 'copilot-cli',
		title: 'Provider settings',
		options: [],
		questions: [
			{
				id: 'optional',
				question: 'Optional value',
				description: 'Optional guidance',
				required: false,
				allowCustom: true,
				options: [],
			},
			{
				id: 'enabled',
				question: 'Enabled',
				required: false,
				default: 'true',
				allowCustom: true,
				options: [],
			},
		],
		createdAt: 1,
	};

	const requiredRequest: HarnessInteractionRequest = {
		...optionalRequest,
		requestId: 'request-required',
		questions: [{ id: 'required', question: 'Required value', allowCustom: true, options: [] }],
	};

	const requiredEmptyRequest: HarnessInteractionRequest = {
		...requiredRequest,
		requestId: 'request-required-empty',
		questions: [{ ...requiredRequest.questions![0], allowEmpty: true }],
	};

	const clearedRequest: HarnessInteractionRequest = {
		...optionalRequest,
		requestId: 'request-cleared',
		questions: [
			{
				id: 'choices',
				question: 'Choices',
				required: false,
				default: ['one'],
				multiSelect: true,
				allowEmpty: true,
				options: [{ optionId: 'one', label: 'one', kind: 'choice' }],
			},
			{
				id: 'text',
				question: 'Text',
				required: false,
				default: 'seed',
				allowCustom: true,
				allowEmpty: true,
				options: [],
			},
		],
	};

	const originalMaestro = window.maestro;

	describe('HarnessInteractionPrompt', () => {
		afterEach(() => {
			useHarnessInteractionStore.setState({ queue: [], responding: {}, settledIds: {} });
			window.maestro = originalMaestro;
		});

		it('renders descriptions and defaults without requiring optional answers', () => {
			const respondHarnessInteraction = vi.fn().mockResolvedValue('resolved');
			window.maestro = {
				...window.maestro,
				process: {
					onHarnessInteractionRequest: vi.fn(() => vi.fn()),
					onHarnessInteractionSettled: vi.fn(() => vi.fn()),
					onExit: vi.fn(() => vi.fn()),
					listHarnessInteractions: vi.fn().mockResolvedValue([]),
					respondHarnessInteraction,
				},
			};
			useHarnessInteractionStore.setState({ queue: [optionalRequest] });
			render(
				<LayerStackProvider>
					<HarnessInteractionPrompt theme={mockTheme} />
				</LayerStackProvider>
			);

			expect(screen.getByText('Optional guidance')).toBeInTheDocument();
			expect(screen.getByDisplayValue('true')).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Answer' })).toBeEnabled();
			const optionalInput = screen.getAllByRole('textbox')[0];
			fireEvent.change(optionalInput, { target: { value: 'temporary' } });
			fireEvent.change(optionalInput, { target: { value: '' } });
			fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
			expect(respondHarnessInteraction).toHaveBeenCalledWith({
				requestId: 'request-optional',
				outcome: 'answers',
				answers: { enabled: 'true' },
			});
		});

		it('preserves deliberate empty strings and arrays instead of restoring defaults', () => {
			const respondHarnessInteraction = vi.fn().mockResolvedValue('resolved');
			window.maestro = {
				...window.maestro,
				process: {
					onHarnessInteractionRequest: vi.fn(() => vi.fn()),
					onHarnessInteractionSettled: vi.fn(() => vi.fn()),
					onExit: vi.fn(() => vi.fn()),
					listHarnessInteractions: vi.fn().mockResolvedValue([]),
					respondHarnessInteraction,
				},
			};
			useHarnessInteractionStore.setState({ queue: [clearedRequest] });
			render(
				<LayerStackProvider>
					<HarnessInteractionPrompt theme={mockTheme} />
				</LayerStackProvider>
			);
			fireEvent.click(screen.getByRole('checkbox'));
			fireEvent.change(screen.getByDisplayValue('seed'), { target: { value: '' } });
			fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
			expect(respondHarnessInteraction).toHaveBeenCalledWith({
				requestId: 'request-cleared',
				outcome: 'answers',
				answers: { choices: [], text: '' },
			});
		});

		it('keeps legacy questions without an optional flag blocked until answered', () => {
			window.maestro = {
				...window.maestro,
				process: {
					onHarnessInteractionRequest: vi.fn(() => vi.fn()),
					onHarnessInteractionSettled: vi.fn(() => vi.fn()),
					onExit: vi.fn(() => vi.fn()),
					listHarnessInteractions: vi.fn().mockResolvedValue([]),
					respondHarnessInteraction: vi.fn().mockResolvedValue('resolved'),
				},
			};
			useHarnessInteractionStore.setState({ queue: [requiredRequest] });
			render(
				<LayerStackProvider>
					<HarnessInteractionPrompt theme={mockTheme} />
				</LayerStackProvider>
			);
			const answer = screen.getByRole('button', { name: 'Answer' });
			expect(answer).toBeDisabled();
			fireEvent.change(screen.getByRole('textbox'), { target: { value: 'typed answer' } });
			expect(answer).toBeEnabled();
		});

		it('allows a required valid empty answer through an explicit control', () => {
			const respondHarnessInteraction = vi.fn().mockResolvedValue('resolved');
			window.maestro = {
				...window.maestro,
				process: {
					onHarnessInteractionRequest: vi.fn(() => vi.fn()),
					onHarnessInteractionSettled: vi.fn(() => vi.fn()),
					onExit: vi.fn(() => vi.fn()),
					listHarnessInteractions: vi.fn().mockResolvedValue([]),
					respondHarnessInteraction,
				},
			};
			useHarnessInteractionStore.setState({ queue: [requiredEmptyRequest] });
			render(
				<LayerStackProvider>
					<HarnessInteractionPrompt theme={mockTheme} />
				</LayerStackProvider>
			);
			const answer = screen.getByRole('button', { name: 'Answer' });
			expect(answer).toBeDisabled();
			fireEvent.click(screen.getByRole('button', { name: 'Leave empty' }));
			expect(answer).toBeEnabled();
			fireEvent.click(answer);
			expect(respondHarnessInteraction).toHaveBeenCalledWith({
				requestId: 'request-required-empty',
				outcome: 'answers',
				answers: { required: '' },
			});
		});
	});
});
describeSourceSuite('CrossTabSearchModal', () => {
	function log(id: string, text: string, overrides: Partial<LogEntry> = {}): LogEntry {
		return { id, text, timestamp: 1_700_000_000_000, source: 'ai', ...overrides } as LogEntry;
	}

	const TABS: AITab[] = [
		createMockAITab({
			id: 'tab-a',
			name: 'Auth work',
			logs: [
				log('a1', 'refactor the login handler', { source: 'user' }),
				log('a2', 'nothing relevant here'),
			],
		}),
		createMockAITab({
			id: 'tab-b',
			name: 'Billing work',
			logs: [log('b1', 'the login flow charges twice')],
		}),
	];

	/** The modal debounces its query by 150ms. */
	function typeQuery(value: string) {
		fireEvent.change(screen.getByRole('textbox'), { target: { value } });
		act(() => {
			vi.advanceTimersByTime(200);
		});
	}

	function renderModal(props: Partial<React.ComponentProps<typeof CrossTabSearchModal>> = {}) {
		const onJump = vi.fn();
		const onClose = vi.fn();
		render(
			<LayerStackProvider>
				<CrossTabSearchModal
					theme={mockTheme}
					tabs={TABS}
					activeTabId="tab-a"
					onJump={onJump}
					onClose={onClose}
					{...props}
				/>
			</LayerStackProvider>
		);
		return { onJump, onClose };
	}

	describe('CrossTabSearchModal', () => {
		beforeEach(() => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
		});

		it('prompts for a query before anything has been typed', () => {
			renderModal();
			expect(screen.getByText('Type to search every open tab in this agent')).toBeInTheDocument();
		});

		// Keyboard-first: however the modal is opened (shortcut, tab-bar popover,
		// command palette), the caret must already be in the search box.
		it('focuses the search input when it opens', () => {
			renderModal();
			act(() => {
				vi.advanceTimersByTime(MOUNT_FOCUS_DELAY_MS);
			});
			expect(screen.getByRole('textbox')).toHaveFocus();
		});

		it('groups hits under each tab that contains them', () => {
			renderModal();
			typeQuery('login');

			expect(screen.getByText('Auth work')).toBeInTheDocument();
			expect(screen.getByText('Billing work')).toBeInTheDocument();
			expect(screen.getByText('2 messages in 2 tabs')).toBeInTheDocument();
		});

		it('marks which group is the tab the user is already on', () => {
			renderModal();
			typeQuery('login');
			expect(screen.getByText('current')).toBeInTheDocument();
		});

		it('highlights the matched span inside the snippet', () => {
			const { container } = { container: document.body };
			renderModal();
			typeQuery('login');

			const marks = Array.from(container.querySelectorAll('mark')).map((m) => m.textContent);
			expect(marks).toEqual(['login', 'login']);
		});

		it('reports when nothing matches', () => {
			renderModal();
			typeQuery('zzzznotfound');
			expect(screen.getByText('No matching messages')).toBeInTheDocument();
		});

		it('hands the tab, entry, and query to onJump, then closes', () => {
			const { onJump, onClose } = renderModal();
			typeQuery('charges');

			// The snippet is split across text nodes by the <mark>, so click the row
			// that owns the highlighted span rather than matching the whole sentence.
			fireEvent.click(screen.getByText('charges').closest('button')!);

			expect(onJump).toHaveBeenCalledWith({
				tabId: 'tab-b',
				logId: 'b1',
				query: 'charges',
				regex: false,
			});
			expect(onClose).toHaveBeenCalled();
		});

		it('jumps to the first hit on Enter', () => {
			const { onJump } = renderModal();
			typeQuery('login');

			fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

			expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'tab-a', logId: 'a1' }));
		});

		it('moves the selection with the arrow keys', () => {
			const { onJump } = renderModal();
			typeQuery('login');

			fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowDown' });
			fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

			expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'tab-b', logId: 'b1' }));
		});

		it('switches to regex matching when the chip is toggled', () => {
			const { onJump } = renderModal();

			fireEvent.click(screen.getByTitle('Switch to regex search'));
			typeQuery('charges? twice');

			fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
			expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ logId: 'b1', regex: true }));
		});

		it('surfaces an invalid regex instead of crashing', () => {
			renderModal();
			fireEvent.click(screen.getByTitle('Switch to regex search'));
			typeQuery('(unclosed');

			expect(screen.getByText(/Invalid regex:/)).toBeInTheDocument();
		});

		// Remote desktop and tablet users have no Escape key to reach for.
		it('closes when the ESC pill is clicked', () => {
			const { onClose } = renderModal();

			fireEvent.click(screen.getByRole('button', { name: 'Close (Esc)' }));

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		// jsdom has no layout engine, so this pins the geometry by class: the overlay
		// must center its box the way TabSwitcherModal does (p-8 == the 32px
		// MODAL_VIEWPORT_PADDING) with the same 700px height, so both search entry
		// points in the search popover open at the same top Y.
		it('centers its box like the tab switcher instead of hugging the top', () => {
			renderModal();
			const dialog = screen.getByRole('dialog');
			const overlay = dialog.parentElement as HTMLElement;

			expect(overlay.className).toContain('items-center');
			expect(overlay.className).toContain('p-8');
			expect(overlay.className).not.toContain('items-start');
			expect(dialog.className).toContain('h-[700px]');
		});

		it('shows a match-count pill when an entry contains several hits', () => {
			renderModal({
				tabs: [
					createMockAITab({ id: 'tab-a', name: 'Repeats', logs: [log('r1', 'ping ping ping')] }),
				],
			});
			typeQuery('ping');
			expect(screen.getByText('3 matches')).toBeInTheDocument();
		});

		// A hidden cross-agent consult tab has no chip in the strip, so a hit inside one
		// would jump the user into a conversation they never opened.
		it('keeps hidden consult tabs out of the search corpus', () => {
			renderModal({
				tabs: [
					...TABS,
					createMockAITab({
						id: 'tab-consult',
						name: 'Consult',
						hidden: true,
						logs: [log('c1', 'the login secret lives here')],
					}),
				],
			});
			typeQuery('login');

			expect(screen.getByText('Auth work')).toBeInTheDocument();
			expect(screen.queryByText('Consult')).not.toBeInTheDocument();
			expect(screen.getByText('Searching 2 open tabs')).toBeInTheDocument();
		});
	});
});
describeSourceSuite('CsvTableRenderer', () => {
	// lucide-react icons are auto-mocked globally in src/__tests__/setup.ts

	describe('CsvTableRenderer', () => {
		describe('basic rendering', () => {
			it('renders a table with header and data rows', () => {
				render(
					<CsvTableRenderer content={'Name,Age,City\nAlice,30,NYC\nBob,25,LA'} theme={mockTheme} />
				);

				expect(screen.getByText('Name')).toBeInTheDocument();
				expect(screen.getByText('Age')).toBeInTheDocument();
				expect(screen.getByText('City')).toBeInTheDocument();
				expect(screen.getByText('Alice')).toBeInTheDocument();
				expect(screen.getByText('30')).toBeInTheDocument();
				expect(screen.getByText('NYC')).toBeInTheDocument();
				expect(screen.getByText('Bob')).toBeInTheDocument();
			});

			it('shows row and column count', () => {
				render(<CsvTableRenderer content={'A,B\n1,2\n3,4\n5,6'} theme={mockTheme} />);

				expect(screen.getByText('3 rows × 2 columns')).toBeInTheDocument();
			});

			it('pins the header inside a scroller that scrolls both axes', () => {
				// A horizontal-only wrapper would be the header's nearest scrolling
				// ancestor while never scrolling vertically, so the header would
				// scroll away with the rows.
				render(<CsvTableRenderer content={'A,B\n1,2\n3,4'} theme={mockTheme} />);

				const header = screen.getByText('A').closest('th');
				expect(header).toHaveStyle({ position: 'sticky', top: '0px' });
				const scroller = header?.closest('[data-preview-scroller]');
				expect(scroller).toHaveClass('overflow-auto');
				expect(scroller).not.toHaveClass('overflow-x-auto');
			});

			it('renders empty state for empty content', () => {
				render(<CsvTableRenderer content="" theme={mockTheme} />);

				expect(screen.getByText('Empty CSV file')).toBeInTheDocument();
			});

			it('shows row numbers starting at 1', () => {
				render(<CsvTableRenderer content={'Name\nAlice\nBob'} theme={mockTheme} />);

				expect(screen.getByText('1')).toBeInTheDocument();
				expect(screen.getByText('2')).toBeInTheDocument();
			});
		});

		describe('CSV parsing', () => {
			it('handles quoted fields with commas', () => {
				render(
					<CsvTableRenderer
						content={'Name,Location\n"Smith, John","New York, NY"'}
						theme={mockTheme}
					/>
				);

				expect(screen.getByText('Smith, John')).toBeInTheDocument();
				expect(screen.getByText('New York, NY')).toBeInTheDocument();
			});

			it('handles escaped quotes inside quoted fields', () => {
				render(<CsvTableRenderer content={'Quote\n"He said ""hello"""'} theme={mockTheme} />);

				expect(screen.getByText('He said "hello"')).toBeInTheDocument();
			});

			it('handles CRLF line endings', () => {
				const { container } = render(
					<CsvTableRenderer content={'A,B\r\n1,2\r\n3,4'} theme={mockTheme} />
				);

				const cells = container.querySelectorAll('tbody td');
				const cellTexts = Array.from(cells).map((c) => c.textContent);
				expect(cellTexts).toContain('1');
				expect(cellTexts).toContain('4');
				expect(screen.getByText('2 rows × 2 columns')).toBeInTheDocument();
			});

			it('handles rows with different column counts', () => {
				render(<CsvTableRenderer content={'A,B,C\n1,2\n3,4,5,6'} theme={mockTheme} />);

				// Should not crash - fills missing cells with empty, ignores extra
				expect(screen.getByText('A')).toBeInTheDocument();
				expect(screen.getByText('3')).toBeInTheDocument();
			});
		});

		describe('column sorting', () => {
			it('sorts ascending on first click', () => {
				const { container } = render(
					<CsvTableRenderer content={'Name,Value\nCharlie,3\nAlice,1\nBob,2'} theme={mockTheme} />
				);

				// Click on the Name header
				fireEvent.click(screen.getByText('Name'));

				// After ascending sort, first data row should be Alice
				const rows = container.querySelectorAll('tbody tr');
				expect(rows[0]).toHaveTextContent('Alice');
				expect(rows[1]).toHaveTextContent('Bob');
				expect(rows[2]).toHaveTextContent('Charlie');
			});

			it('sorts descending on second click', () => {
				const { container } = render(
					<CsvTableRenderer content={'Name,Value\nCharlie,3\nAlice,1\nBob,2'} theme={mockTheme} />
				);

				// Click twice for descending
				fireEvent.click(screen.getByText('Name'));
				fireEvent.click(screen.getByText('Name'));

				const rows = container.querySelectorAll('tbody tr');
				expect(rows[0]).toHaveTextContent('Charlie');
				expect(rows[1]).toHaveTextContent('Bob');
				expect(rows[2]).toHaveTextContent('Alice');
			});

			it('clears sort on third click', () => {
				const { container } = render(
					<CsvTableRenderer content={'Name,Value\nCharlie,3\nAlice,1\nBob,2'} theme={mockTheme} />
				);

				// Click three times to clear sort
				fireEvent.click(screen.getByText('Name'));
				fireEvent.click(screen.getByText('Name'));
				fireEvent.click(screen.getByText('Name'));

				// Back to original order
				const rows = container.querySelectorAll('tbody tr');
				expect(rows[0]).toHaveTextContent('Charlie');
				expect(rows[1]).toHaveTextContent('Alice');
				expect(rows[2]).toHaveTextContent('Bob');
			});

			it('sorts numeric columns numerically', () => {
				const { container } = render(
					<CsvTableRenderer content={'Item,Price\nA,10\nB,2\nC,100'} theme={mockTheme} />
				);

				fireEvent.click(screen.getByText('Price'));

				const rows = container.querySelectorAll('tbody tr');
				// Numeric sort: 2, 10, 100 (not lexicographic "10", "100", "2")
				expect(rows[0]).toHaveTextContent('2');
				expect(rows[1]).toHaveTextContent('10');
				expect(rows[2]).toHaveTextContent('100');
			});

			it('shows sort indicator on sorted column', () => {
				render(<CsvTableRenderer content={'Name,Age\nAlice,30'} theme={mockTheme} />);

				fireEvent.click(screen.getByText('Name'));

				expect(screen.getByTestId('chevronup-icon')).toBeInTheDocument();
			});
		});

		describe('truncation', () => {
			it('shows truncation banner for large datasets', () => {
				// Generate 600 rows
				const header = 'ID,Value';
				const rows = Array.from({ length: 600 }, (_, i) => `${i},val${i}`).join('\n');
				const content = `${header}\n${rows}`;

				render(<CsvTableRenderer content={content} theme={mockTheme} />);

				expect(screen.getByText(/Showing 500 of 600 rows/)).toBeInTheDocument();
			});

			it('does not show truncation banner for small datasets', () => {
				render(<CsvTableRenderer content={'A,B\n1,2\n3,4'} theme={mockTheme} />);

				expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
			});
		});

		describe('TSV delimiter support', () => {
			it('parses tab-delimited content with delimiter prop', () => {
				render(
					<CsvTableRenderer
						content={'Name\tAge\tCity\nAlice\t30\tNYC\nBob\t25\tLA'}
						theme={mockTheme}
						delimiter={'\t'}
					/>
				);

				expect(screen.getByText('Name')).toBeInTheDocument();
				expect(screen.getByText('Age')).toBeInTheDocument();
				expect(screen.getByText('Alice')).toBeInTheDocument();
				expect(screen.getByText('NYC')).toBeInTheDocument();
				expect(screen.getByText('2 rows × 3 columns')).toBeInTheDocument();
			});

			it('handles quoted fields in TSV', () => {
				render(
					<CsvTableRenderer
						content={'Name\tNote\n"Smith, John"\t"Has\ttab"'}
						theme={mockTheme}
						delimiter={'\t'}
					/>
				);

				expect(screen.getByText('Smith, John')).toBeInTheDocument();
			});

			it('sorts TSV columns correctly', () => {
				const { container } = render(
					<CsvTableRenderer
						content={'Name\tValue\nCharlie\t3\nAlice\t1\nBob\t2'}
						theme={mockTheme}
						delimiter={'\t'}
					/>
				);

				fireEvent.click(screen.getByText('Name'));
				const rows = container.querySelectorAll('tbody tr');
				expect(rows[0]).toHaveTextContent('Alice');
				expect(rows[2]).toHaveTextContent('Charlie');
			});
		});

		describe('numeric detection', () => {
			it('right-aligns columns with majority numeric values', () => {
				const { container } = render(
					<CsvTableRenderer content={'Value\n100\n200\n300'} theme={mockTheme} />
				);

				// Numeric columns get right-aligned td cells
				const cells = container.querySelectorAll('tbody td');
				// Skip row-number cell (index 0), check data cell (index 1)
				expect((cells[1] as HTMLElement).style.textAlign).toBe('right');
			});

			it('does not treat trailing-dot numbers as numeric (e.g., "123.")', () => {
				const { container } = render(
					<CsvTableRenderer content={'Value\n123.\n456.\n789.'} theme={mockTheme} />
				);

				// "123." is not a valid number - column should be left-aligned
				const cells = container.querySelectorAll('tbody td');
				expect((cells[1] as HTMLElement).style.textAlign).toBe('left');
			});

			it('treats proper decimals as numeric', () => {
				const { container } = render(
					<CsvTableRenderer content={'Value\n1.50\n2.75\n3.00'} theme={mockTheme} />
				);

				const cells = container.querySelectorAll('tbody td');
				expect((cells[1] as HTMLElement).style.textAlign).toBe('right');
			});
		});

		describe('search filtering', () => {
			it('filters rows to only those matching the search query', () => {
				const { container } = render(
					<CsvTableRenderer
						content={'Name,City\nAlice,NYC\nBob,LA\nCharlie,NYC'}
						theme={mockTheme}
						searchQuery="NYC"
					/>
				);

				const rows = container.querySelectorAll('tbody tr');
				expect(rows).toHaveLength(2);
				expect(rows[0]).toHaveTextContent('Alice');
				expect(rows[1]).toHaveTextContent('Charlie');
			});

			it('performs case-insensitive search', () => {
				const { container } = render(
					<CsvTableRenderer
						content={'Name,City\nAlice,NYC\nBob,LA'}
						theme={mockTheme}
						searchQuery="nyc"
					/>
				);

				const rows = container.querySelectorAll('tbody tr');
				expect(rows).toHaveLength(1);
				expect(rows[0]).toHaveTextContent('Alice');
			});

			it('shows match count in footer when filtering', () => {
				render(
					<CsvTableRenderer
						content={'Name,City\nAlice,NYC\nBob,LA\nCharlie,NYC'}
						theme={mockTheme}
						searchQuery="NYC"
					/>
				);

				expect(screen.getByText(/2 of 3 rows match/)).toBeInTheDocument();
			});

			it('shows all rows when search query is empty', () => {
				const { container } = render(
					<CsvTableRenderer
						content={'Name,City\nAlice,NYC\nBob,LA'}
						theme={mockTheme}
						searchQuery=""
					/>
				);

				const rows = container.querySelectorAll('tbody tr');
				expect(rows).toHaveLength(2);
			});

			it('calls onMatchCount with filtered row count', () => {
				const onMatchCount = vi.fn();
				render(
					<CsvTableRenderer
						content={'Name,City\nAlice,NYC\nBob,LA\nCharlie,NYC'}
						theme={mockTheme}
						searchQuery="NYC"
						onMatchCount={onMatchCount}
					/>
				);

				expect(onMatchCount).toHaveBeenCalledWith(2);
			});

			it('truncates very long search queries to prevent ReDoS', () => {
				const longQuery = 'a'.repeat(300);
				const { container } = render(
					<CsvTableRenderer
						content={'Name\n' + 'a'.repeat(250)}
						theme={mockTheme}
						searchQuery={longQuery}
					/>
				);

				// Should render without hanging - the query is truncated to 200 chars
				const rows = container.querySelectorAll('tbody tr');
				expect(rows).toHaveLength(1);
			});

			it('highlights matching text in cells', () => {
				const { container } = render(
					<CsvTableRenderer content={'Name,City\nAlice,NYC'} theme={mockTheme} searchQuery="NYC" />
				);

				const marks = container.querySelectorAll('mark');
				expect(marks).toHaveLength(1);
				expect(marks[0]).toHaveTextContent('NYC');
			});
		});

		describe('row detail modal', () => {
			const renderWithLayers = (ui: React.ReactElement) =>
				render(<LayerStackProvider>{ui}</LayerStackProvider>);

			const openRow = (container: HTMLElement, rowIdx: number) => {
				const rows = container.querySelectorAll('tbody tr');
				fireEvent.doubleClick(rows[rowIdx]);
			};

			it('opens on a single tap under a coarse pointer', () => {
				// A finger cannot double-tap and a phone has no keyboard to fall back
				// on, so on touch one tap on the row is the way into the record view.
				setCoarsePointer(true);
				try {
					const { container } = renderWithLayers(
						<CsvTableRenderer content={'Name,City\nAlice,NYC\nBob,LA'} theme={mockTheme} />
					);
					fireEvent.click(container.querySelectorAll('tbody tr')[1]);
					expect(screen.getByTestId('csv-row-detail-modal')).toBeInTheDocument();
				} finally {
					restorePointer();
				}
			});

			it('a single click under a mouse leaves the table alone', () => {
				const { container } = renderWithLayers(
					<CsvTableRenderer content={'Name,City\nAlice,NYC\nBob,LA'} theme={mockTheme} />
				);
				fireEvent.click(container.querySelectorAll('tbody tr')[1]);
				expect(screen.queryByTestId('csv-row-detail-modal')).not.toBeInTheDocument();
			});

			it('opens on double-click with the row as field/value pairs', () => {
				const { container } = renderWithLayers(
					<CsvTableRenderer content={'Name,City\nAlice,NYC\nBob,LA'} theme={mockTheme} />
				);

				expect(screen.queryByTestId('csv-row-detail-modal')).not.toBeInTheDocument();

				openRow(container, 1);

				const modal = screen.getByTestId('csv-row-detail-modal');
				expect(modal).toBeInTheDocument();
				expect(modal).toHaveTextContent('Row 2');
				// Field names come from the header row, values from the clicked row
				const pairs = modal.querySelectorAll('tbody tr');
				expect(pairs).toHaveLength(2);
				expect(pairs[0]).toHaveTextContent('Name');
				expect(pairs[0]).toHaveTextContent('Bob');
				expect(pairs[1]).toHaveTextContent('City');
				expect(pairs[1]).toHaveTextContent('LA');
			});

			it('preserves newlines inside a quoted multi-line cell', () => {
				const { container } = renderWithLayers(
					<CsvTableRenderer content={'Name,Notes\nAlice,"line one\nline two"'} theme={mockTheme} />
				);

				openRow(container, 0);

				const valueCell = screen
					.getByTestId('csv-row-detail-modal')
					.querySelectorAll('tbody tr')[1]
					?.querySelectorAll('td')[1];
				expect(valueCell?.textContent).toBe('line one\nline two');
				expect(valueCell).toHaveStyle({ whiteSpace: 'pre-wrap' });
			});

			it('filters fields by key or value', () => {
				const { container } = renderWithLayers(
					<CsvTableRenderer content={'Name,City,Age\nAlice,NYC,30'} theme={mockTheme} />
				);

				openRow(container, 0);
				fireEvent.change(screen.getByTestId('csv-row-detail-search'), {
					target: { value: 'nyc' },
				});

				const modal = screen.getByTestId('csv-row-detail-modal');
				const pairs = modal.querySelectorAll('tbody tr');
				expect(pairs).toHaveLength(1);
				expect(pairs[0]).toHaveTextContent('City');
				// Matches are highlighted
				expect(modal.querySelectorAll('mark')).toHaveLength(1);
			});

			it('shows an empty state when nothing matches the filter', () => {
				const { container } = renderWithLayers(
					<CsvTableRenderer content={'Name,City\nAlice,NYC'} theme={mockTheme} />
				);

				openRow(container, 0);
				fireEvent.change(screen.getByTestId('csv-row-detail-search'), {
					target: { value: 'zzz' },
				});

				expect(screen.getByText(/No fields match/)).toBeInTheDocument();
			});

			it('navigates between rows with the header buttons', () => {
				const { container } = renderWithLayers(
					<CsvTableRenderer content={'Name\nAlice\nBob\nCarol'} theme={mockTheme} />
				);

				openRow(container, 0);
				const modal = screen.getByTestId('csv-row-detail-modal');
				expect(modal).toHaveTextContent('Alice');

				fireEvent.click(screen.getByLabelText('Next row'));
				expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Bob');

				fireEvent.click(screen.getByLabelText('Previous row'));
				expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Alice');
				// First row: no previous
				expect(screen.getByLabelText('Previous row')).toBeDisabled();
			});

			it('navigates rows with Left and Right arrows', () => {
				const { container } = renderWithLayers(
					<CsvTableRenderer content={'Name\nAlice\nBob\nCarol'} theme={mockTheme} />
				);

				openRow(container, 0);
				const fields = screen.getByTestId('csv-row-detail-fields');
				expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Alice');

				fireEvent.keyDown(fields, { key: 'ArrowRight' });
				expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Bob');

				fireEvent.keyDown(fields, { key: 'ArrowRight' });
				expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Carol');

				fireEvent.keyDown(fields, { key: 'ArrowLeft' });
				expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Bob');
			});

			it('stops at the first and last row', () => {
				const { container } = renderWithLayers(
					<CsvTableRenderer content={'Name\nAlice\nBob'} theme={mockTheme} />
				);

				openRow(container, 0);
				const fields = screen.getByTestId('csv-row-detail-fields');

				fireEvent.keyDown(fields, { key: 'ArrowLeft' });
				expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Alice');

				fireEvent.keyDown(fields, { key: 'ArrowRight' });
				fireEvent.keyDown(fields, { key: 'ArrowRight' });
				expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Bob');
			});

			it('scrolls instead of navigating on Up and Down', () => {
				const { container } = renderWithLayers(
					<CsvTableRenderer content={'Name\nAlice\nBob'} theme={mockTheme} />
				);

				openRow(container, 0);
				const fields = screen.getByTestId('csv-row-detail-fields');
				const scrollBy = vi.fn();
				fields.scrollBy = scrollBy;

				fireEvent.keyDown(fields, { key: 'ArrowDown' });
				// Still row 1: Down must not step to the next record
				expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Alice');
				expect(scrollBy).toHaveBeenCalledWith({ top: 48 });

				fireEvent.keyDown(fields, { key: 'ArrowUp' });
				expect(scrollBy).toHaveBeenCalledWith({ top: -48 });
				expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Alice');
			});

			it('leaves arrow keys to the caret while the filter has focus', () => {
				const { container } = renderWithLayers(
					<CsvTableRenderer content={'Name\nAlice\nBob'} theme={mockTheme} />
				);

				openRow(container, 0);
				const search = screen.getByTestId('csv-row-detail-search');
				fireEvent.keyDown(search, { key: 'ArrowRight' });

				// Right inside the input moves the caret, it does not change rows
				expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Alice');
			});

			it('ignores modified arrows so OS and browser bindings still work', () => {
				const { container } = renderWithLayers(
					<CsvTableRenderer content={'Name\nAlice\nBob'} theme={mockTheme} />
				);

				openRow(container, 0);
				const fields = screen.getByTestId('csv-row-detail-fields');
				fireEvent.keyDown(fields, { key: 'ArrowRight', metaKey: true });

				expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Alice');
			});

			it('focuses the field list on open so the arrows work without a click', async () => {
				// If the filter input took initial focus the arrows would all be caret
				// movement and the whole scheme would be dead until the user clicked.
				const { container } = renderWithLayers(
					<CsvTableRenderer content={'Name\nAlice'} theme={mockTheme} />
				);

				openRow(container, 0);

				await waitFor(() => expect(screen.getByTestId('csv-row-detail-fields')).toHaveFocus());
			});

			it('focuses the filter on / and returns to the list on Enter', () => {
				const { container } = renderWithLayers(
					<CsvTableRenderer content={'Name\nAlice'} theme={mockTheme} />
				);

				openRow(container, 0);
				const fields = screen.getByTestId('csv-row-detail-fields');
				const search = screen.getByTestId('csv-row-detail-search');

				fireEvent.keyDown(fields, { key: '/' });
				expect(search).toHaveFocus();

				fireEvent.keyDown(search, { key: 'Enter' });
				expect(fields).toHaveFocus();
			});

			it('labels columns with no header cell', () => {
				const { container } = renderWithLayers(
					<CsvTableRenderer content={'Name\nAlice,extra'} theme={mockTheme} />
				);

				openRow(container, 0);

				expect(screen.getByTestId('csv-row-detail-modal')).toHaveTextContent('Column 2');
			});

			it('renders outside the table subtree so the backdrop can dim the side panels', () => {
				// The table lives inside the Main Panel, whose `isolate` wrapper is a
				// stacking context: an in-place backdrop dims only the center while the
				// Left Bar (relative z-20) and Right Panel paint over it. jsdom has no
				// layout engine, so assert the modal is NOT a descendant of the
				// renderer rather than that it is visible.
				const { container } = renderWithLayers(
					<CsvTableRenderer content={'Name\nAlice'} theme={mockTheme} />
				);

				openRow(container, 0);

				const modal = screen.getByTestId('csv-row-detail-modal');
				expect(container.querySelector('.csv-table-renderer')).not.toContainElement(modal);
				expect(modal.parentElement).toBe(document.body);
			});

			it('closes on the header close button', () => {
				const { container } = renderWithLayers(
					<CsvTableRenderer content={'Name\nAlice'} theme={mockTheme} />
				);

				openRow(container, 0);
				fireEvent.click(screen.getByLabelText('Close modal'));

				expect(screen.queryByTestId('csv-row-detail-modal')).not.toBeInTheDocument();
			});
		});
	});
});
describeSourceSuite('SnoozeTabModal', () => {
	function setup(overrides: Record<string, unknown> = {}) {
		const onConfirm = vi.fn();
		const onClose = vi.fn();
		render(
			<LayerStackProvider>
				<SnoozeTabModal
					theme={mockTheme}
					tabLabel="Some tab"
					onClose={onClose}
					onConfirm={onConfirm}
					{...overrides}
				/>
			</LayerStackProvider>
		);
		return { onConfirm, onClose };
	}

	/** The free-form "Or type it" input. */
	const typeInput = () => screen.getByPlaceholderText(/1d, 10h, 2 weeks/i);
	/** The note-to-self textarea. */
	const noteArea = () => screen.getByPlaceholderText(/Why are you coming back/i);
	/** The prompt-on-return textarea (only rendered when the tab can be prompted). */
	const promptArea = () => screen.getByTestId('snooze-wake-prompt');

	/** Give the dialog a resolvable time so confirm is enabled. */
	function enterExpression(value = '2 weeks') {
		fireEvent.change(typeInput(), { target: { value } });
	}

	describe('SnoozeTabModal keyboard commit', () => {
		it('commits on Cmd+Enter from the note textarea', () => {
			const { onConfirm } = setup();
			enterExpression();
			fireEvent.keyDown(noteArea(), { key: 'Enter', metaKey: true });
			expect(onConfirm).toHaveBeenCalledTimes(1);
		});

		it('commits on Ctrl+Enter from the note textarea', () => {
			const { onConfirm } = setup();
			enterExpression();
			fireEvent.keyDown(noteArea(), { key: 'Enter', ctrlKey: true });
			expect(onConfirm).toHaveBeenCalledTimes(1);
		});

		it('commits on Cmd+Enter from a focused preset button', () => {
			const { onConfirm } = setup();
			enterExpression();
			// A real preset inside the dialog body - not the header close button, which
			// sits outside the wrapper the handler is attached to.
			fireEvent.keyDown(screen.getByRole('button', { name: /Tomorrow/i }), {
				key: 'Enter',
				metaKey: true,
			});
			expect(onConfirm).toHaveBeenCalledTimes(1);
		});

		it('fires onConfirm EXACTLY ONCE for Cmd+Enter in the free-form input', () => {
			// The regression this whole change risks: the input's own Enter handler
			// also matches Cmd+Enter, so without narrowing it the event commits at the
			// target and again on bubble.
			const { onConfirm } = setup();
			enterExpression();
			fireEvent.keyDown(typeInput(), { key: 'Enter', metaKey: true });
			expect(onConfirm).toHaveBeenCalledTimes(1);
		});

		it('still commits on plain Enter in the free-form input', () => {
			const { onConfirm } = setup();
			enterExpression();
			fireEvent.keyDown(typeInput(), { key: 'Enter' });
			expect(onConfirm).toHaveBeenCalledTimes(1);
		});

		it('leaves Enter and Cmd+Enter to the input method during an IME composition', () => {
			const { onConfirm } = setup();
			enterExpression();
			for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
				expect(fireEvent.keyDown(typeInput(), { key: 'Enter', ...ime })).toBe(true);
				expect(fireEvent.keyDown(typeInput(), { key: 'Enter', metaKey: true, ...ime })).toBe(true);
				expect(fireEvent.keyDown(noteArea(), { key: 'Enter', metaKey: true, ...ime })).toBe(true);
			}
			expect(onConfirm).not.toHaveBeenCalled();
		});

		it('leaves plain Enter in the textarea alone, so it stays a newline', () => {
			const { onConfirm } = setup();
			enterExpression();
			fireEvent.keyDown(noteArea(), { key: 'Enter' });
			expect(onConfirm).not.toHaveBeenCalled();
		});

		it('does nothing on Cmd+Enter when no time has been chosen', () => {
			// Same rule the confirm button follows: nothing resolvable, nothing to do.
			const { onConfirm } = setup();
			fireEvent.keyDown(noteArea(), { key: 'Enter', metaKey: true });
			expect(onConfirm).not.toHaveBeenCalled();
		});

		it('passes the trimmed note through with the resolved time', () => {
			const { onConfirm } = setup();
			enterExpression();
			fireEvent.change(noteArea(), { target: { value: '  check the deploy  ' } });
			fireEvent.keyDown(noteArea(), { key: 'Enter', metaKey: true });
			expect(onConfirm).toHaveBeenCalledWith(
				expect.any(Number),
				expect.objectContaining({ note: 'check the deploy' })
			);
		});
	});

	describe('SnoozeTabModal wake prompt', () => {
		it('is hidden unless the parked tab can actually be prompted', () => {
			// A file, terminal, or browser tab has no conversation to send to, so
			// offering the field there would collect a prompt that could never run.
			setup();
			expect(screen.queryByTestId('snooze-wake-prompt')).not.toBeInTheDocument();
		});

		it('passes the trimmed prompt through alongside the note', () => {
			const { onConfirm } = setup({ canRunWakePrompt: true });
			enterExpression();
			fireEvent.change(noteArea(), { target: { value: 'why' } });
			fireEvent.change(promptArea(), { target: { value: '  run the tests  ' } });
			fireEvent.keyDown(noteArea(), { key: 'Enter', metaKey: true });

			expect(onConfirm).toHaveBeenCalledWith(expect.any(Number), {
				note: 'why',
				wakePrompt: 'run the tests',
			});
		});

		it('commits on Cmd+Enter from the prompt textarea too', () => {
			const { onConfirm } = setup({ canRunWakePrompt: true });
			enterExpression();
			fireEvent.keyDown(promptArea(), { key: 'Enter', metaKey: true });
			expect(onConfirm).toHaveBeenCalledTimes(1);
		});

		it('opens pre-filled when rescheduling a snooze that already has one', () => {
			setup({
				canRunWakePrompt: true,
				initialWakeAt: Date.now() + 3600_000,
				initialWakePrompt: 'go on',
			});
			expect(promptArea()).toHaveValue('go on');
		});

		it('sends an empty prompt when the field is cleared, so a reschedule removes it', () => {
			// An omitted field means "keep what was there", so emptying the box has to
			// travel as an empty string or the deletion is silently discarded.
			const { onConfirm } = setup({
				canRunWakePrompt: true,
				initialWakeAt: Date.now() + 3600_000,
				initialWakePrompt: 'go on',
			});
			fireEvent.change(promptArea(), { target: { value: '' } });
			fireEvent.keyDown(noteArea(), { key: 'Enter', metaKey: true });

			expect(onConfirm).toHaveBeenCalledWith(
				expect.any(Number),
				expect.objectContaining({ wakePrompt: '' })
			);
		});
	});
});
