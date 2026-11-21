// Source: src/__tests__/renderer/components/InputArea/overlays/SlashCommandPopover.test.tsx
// Source: src/__tests__/renderer/components/InputArea/overlays/CommandHistoryPopover.test.tsx
// Source: src/__tests__/renderer/components/InputArea/overlays/AtMentionPopover.test.tsx
// Source: src/__tests__/renderer/components/InputArea/overlays/TabCompletionPopover.test.tsx
// Source: src/__tests__/renderer/components/InputArea/utils/commandHistory.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { SlashCommandPopover } from '../../../../../renderer/components/InputArea/overlays/SlashCommandPopover';
import { createItemRefs } from '../_fixtures';
import { inputAreaTheme } from '../_fixtures';
import { CommandHistoryPopover } from '../../../../../renderer/components/InputArea/overlays/CommandHistoryPopover';
import { act } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import { beforeEach } from 'vitest';
import { AtMentionPopover } from '../../../../../renderer/components/InputArea/overlays/AtMentionPopover';
import type { MentionCategory } from '../../../../../renderer/hooks/input/useMentionPicker';
import type { MentionPickerItem } from '../../../../../renderer/hooks/input/useMentionPicker';
import { ipcCache } from '../../../../../renderer/services/ipcWrapper';
import { TabCompletionPopover } from '../../../../../renderer/components/InputArea/overlays/TabCompletionPopover';
import { filterCommandHistory } from '../../../../../renderer/components/InputArea/utils/commandHistory';
import { getCurrentCommandHistory } from '../../../../../renderer/components/InputArea/utils/commandHistory';
import { createInputAreaSession } from '../_fixtures';

describeSourceSuite('SlashCommandPopover', () => {
	describe('SlashCommandPopover', () => {
		const commands = [
			{ command: '/clear', description: 'Clear chat history' },
			{ command: '/help', description: 'Show help' },
		];

		it('renders nothing when closed or empty', () => {
			const { rerender } = render(
				<SlashCommandPopover
					isOpen={false}
					commands={commands}
					inputValueLower="/"
					selectedIndex={0}
					itemRefs={createItemRefs<HTMLButtonElement>()}
					theme={inputAreaTheme}
					setInputValue={vi.fn()}
					setSlashCommandOpen={vi.fn()}
					setSelectedSlashCommandIndex={vi.fn()}
					inputRef={{ current: null }}
				/>
			);

			expect(screen.queryByText('/clear')).not.toBeInTheDocument();

			rerender(
				<SlashCommandPopover
					isOpen
					commands={[]}
					inputValueLower="/"
					selectedIndex={0}
					itemRefs={createItemRefs<HTMLButtonElement>()}
					theme={inputAreaTheme}
					setInputValue={vi.fn()}
					setSlashCommandOpen={vi.fn()}
					setSelectedSlashCommandIndex={vi.fn()}
					inputRef={{ current: null }}
				/>
			);

			expect(screen.queryByText('/clear')).not.toBeInTheDocument();
		});

		it('renders commands, descriptions, and selected styling', () => {
			render(
				<SlashCommandPopover
					isOpen
					commands={commands}
					inputValueLower="/"
					selectedIndex={1}
					itemRefs={createItemRefs<HTMLButtonElement>()}
					theme={inputAreaTheme}
					setInputValue={vi.fn()}
					setSlashCommandOpen={vi.fn()}
					setSelectedSlashCommandIndex={vi.fn()}
					inputRef={{ current: null }}
				/>
			);

			expect(screen.getByText('/clear')).toBeInTheDocument();
			expect(screen.getByText('Show help')).toBeInTheDocument();
			expect(screen.getByText('/help').closest('button')).toHaveClass('font-semibold');
		});

		// A SINGLE click has to accept. This popover used to treat a click as
		// "move the highlight" and leave acceptance to a double-click, which a
		// touch screen cannot produce and a phone has no keyboard to substitute
		// for: the menu opened and every tap did nothing.
		it('accepts the command on a single click', () => {
			const setSelected = vi.fn();
			const setInputValue = vi.fn();
			const setOpen = vi.fn();
			const focus = vi.fn();

			render(
				<SlashCommandPopover
					isOpen
					commands={commands}
					inputValueLower="/"
					selectedIndex={0}
					itemRefs={createItemRefs<HTMLButtonElement>()}
					theme={inputAreaTheme}
					setInputValue={setInputValue}
					setSlashCommandOpen={setOpen}
					setSelectedSlashCommandIndex={setSelected}
					inputRef={{ current: { focus } as HTMLTextAreaElement }}
				/>
			);

			const help = screen.getByText('/help').closest('button')!;
			fireEvent.mouseEnter(help);
			fireEvent.click(help);

			expect(setSelected).toHaveBeenCalledWith(1);
			// Trailing space, matching what Tab/Enter writes in useInputKeyDown, so a
			// tapped command and a typed one leave the caret in the same place.
			expect(setInputValue).toHaveBeenCalledWith('/help ');
			expect(setOpen).toHaveBeenCalledWith(false);
			expect(focus).toHaveBeenCalled();
		});
	});
});
describeSourceSuite('CommandHistoryPopover', () => {
	describe('CommandHistoryPopover', () => {
		function renderPopover(overrides = {}) {
			return render(
				<CommandHistoryPopover
					isOpen
					isTerminalMode={false}
					filter=""
					selectedIndex={0}
					filteredHistory={['hello world', 'explain code']}
					theme={inputAreaTheme}
					setFilter={vi.fn()}
					setOpen={vi.fn()}
					setSelectedIndex={vi.fn()}
					setInputValue={vi.fn()}
					inputRef={{ current: null }}
					{...overrides}
				/>
			);
		}

		it('renders nothing when closed', () => {
			renderPopover({ isOpen: false });

			expect(screen.queryByText('hello world')).not.toBeInTheDocument();
		});

		it('uses AI and terminal placeholders/empty text', () => {
			const { rerender } = renderPopover({ filteredHistory: [] });

			expect(screen.getByPlaceholderText('Filter messages...')).toBeInTheDocument();
			expect(screen.getByText('No matching messages')).toBeInTheDocument();

			rerender(
				<CommandHistoryPopover
					isOpen
					isTerminalMode
					filter=""
					selectedIndex={0}
					filteredHistory={[]}
					theme={inputAreaTheme}
					setFilter={vi.fn()}
					setOpen={vi.fn()}
					setSelectedIndex={vi.fn()}
					setInputValue={vi.fn()}
					inputRef={{ current: null }}
				/>
			);

			expect(screen.getByPlaceholderText('Filter commands...')).toBeInTheDocument();
			expect(screen.getByText('No matching commands')).toBeInTheDocument();
		});

		it('updates filter and resets selection', () => {
			const setFilter = vi.fn();
			const setSelectedIndex = vi.fn();
			renderPopover({ setFilter, setSelectedIndex });

			fireEvent.change(screen.getByPlaceholderText('Filter messages...'), {
				target: { value: 'hello' },
			});

			expect(setFilter).toHaveBeenCalledWith('hello');
			expect(setSelectedIndex).toHaveBeenCalledWith(0);
		});

		it('handles keyboard navigation, Enter, and Escape', () => {
			vi.useFakeTimers();
			const setSelectedIndex = vi.fn();
			const setInputValue = vi.fn();
			const setOpen = vi.fn();
			const setFilter = vi.fn();
			const focus = vi.fn();
			renderPopover({
				setSelectedIndex,
				setInputValue,
				setOpen,
				setFilter,
				inputRef: { current: { focus } as HTMLTextAreaElement },
			});

			const filter = screen.getByPlaceholderText('Filter messages...');
			fireEvent.keyDown(filter, { key: 'ArrowDown' });
			fireEvent.keyDown(filter, { key: 'ArrowUp' });
			fireEvent.keyDown(filter, { key: 'Enter' });
			fireEvent.keyDown(filter, { key: 'Escape' });
			vi.runAllTimers();

			expect(setSelectedIndex).toHaveBeenCalledWith(1);
			expect(setSelectedIndex).toHaveBeenCalledWith(0);
			expect(setInputValue).toHaveBeenCalledWith('hello world');
			expect(setOpen).toHaveBeenCalledWith(false);
			expect(setFilter).toHaveBeenCalledWith('');
			expect(focus).toHaveBeenCalled();
			vi.useRealTimers();
		});

		it('selects a history item on click and updates hover selection', () => {
			const setInputValue = vi.fn();
			const setSelectedIndex = vi.fn();
			const focus = vi.fn();
			renderPopover({
				setInputValue,
				setSelectedIndex,
				inputRef: { current: { focus } as HTMLTextAreaElement },
			});

			const second = screen.getByText('explain code');
			fireEvent.mouseEnter(second);
			fireEvent.click(second);

			expect(setSelectedIndex).toHaveBeenCalledWith(1);
			expect(setInputValue).toHaveBeenCalledWith('explain code');
			expect(focus).toHaveBeenCalled();
		});

		it('does not select or close on Enter during active IME composition (isComposing: true)', () => {
			const setInputValue = vi.fn();
			const setOpen = vi.fn();
			renderPopover({ setInputValue, setOpen });

			const filter = screen.getByPlaceholderText('Filter messages...');
			const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
			Object.defineProperty(event, 'isComposing', { value: true });
			const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

			filter.dispatchEvent(event);

			expect(setInputValue).not.toHaveBeenCalled();
			expect(setOpen).not.toHaveBeenCalled();
			expect(preventDefaultSpy).not.toHaveBeenCalled();
		});

		it('does not select or close on Enter during Safari IME confirmation (keyCode 229)', () => {
			const setInputValue = vi.fn();
			const setOpen = vi.fn();
			renderPopover({ setInputValue, setOpen });

			const filter = screen.getByPlaceholderText('Filter messages...');
			const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
			Object.defineProperty(event, 'keyCode', { value: 229 });
			const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

			filter.dispatchEvent(event);

			expect(setInputValue).not.toHaveBeenCalled();
			expect(setOpen).not.toHaveBeenCalled();
			expect(preventDefaultSpy).not.toHaveBeenCalled();
		});
	});
});
describeSourceSuite('AtMentionPopover', () => {
	/**
	 * Post-Phase-01 the popover is driven by the unified `items` / `counts` /
	 * `category` API (not the legacy `suggestions` prop), with an Agents category
	 * alongside files/directories and a no-other-agents empty state.
	 */
	describe('AtMentionPopover', () => {
		const items: MentionPickerItem[] = [
			{
				kind: 'file',
				value: '@src/index.ts ',
				displayText: 'index.ts',
				fullPath: 'src/index.ts',
				score: 3,
			},
			{
				kind: 'file',
				value: '@docs/tasks.md ',
				displayText: 'tasks.md',
				fullPath: 'docs/tasks.md',
				score: 2,
				source: 'autorun',
			},
			{
				kind: 'directory',
				value: '@src/utils/',
				displayText: 'utils',
				fullPath: 'src/utils',
				score: 1,
			},
		];

		const counts: Record<MentionCategory, number> = {
			all: 4,
			files: 2,
			directories: 1,
			agents: 1,
		};

		beforeEach(() => {
			// The SSH name lookup reads through the shared 30s ipcCache entry, so a
			// prior test's configs would otherwise leak into the next one.
			ipcCache.invalidate('ssh-configs');
		});

		function renderPopover(overrides: Record<string, unknown> = {}) {
			return render(
				<AtMentionPopover
					isOpen
					isTerminalMode={false}
					items={items}
					counts={counts}
					category={'all' as MentionCategory}
					setCategory={vi.fn()}
					selectedIndex={0}
					filter="src"
					startIndex={5}
					inputValue="open @src now"
					itemRefs={createItemRefs<HTMLButtonElement>()}
					theme={inputAreaTheme}
					setInputValue={vi.fn()}
					setOpen={vi.fn()}
					setFilter={vi.fn()}
					setStartIndex={vi.fn()}
					setSelectedIndex={vi.fn()}
					inputRef={{ current: null }}
					{...overrides}
				/>
			);
		}

		it('renders nothing when closed or in terminal mode', () => {
			const { rerender } = renderPopover({ isOpen: false });
			expect(screen.queryByText('src/index.ts')).not.toBeInTheDocument();

			rerender(
				<AtMentionPopover
					isOpen
					isTerminalMode
					items={items}
					counts={counts}
					category={'all' as MentionCategory}
					selectedIndex={0}
					filter=""
					startIndex={0}
					inputValue="@"
					itemRefs={createItemRefs<HTMLButtonElement>()}
					theme={inputAreaTheme}
					setInputValue={vi.fn()}
					inputRef={{ current: null }}
				/>
			);
			expect(screen.queryByText('Files')).not.toBeInTheDocument();
		});

		it('renders the category bar, file/dir rows, and the Auto Run badge', () => {
			renderPopover({ selectedIndex: 2 });

			expect(screen.getByText('All')).toBeInTheDocument();
			expect(screen.getByText('Files')).toBeInTheDocument();
			expect(screen.getByText('Directories')).toBeInTheDocument();
			expect(screen.getByText('Agents')).toBeInTheDocument();
			expect(screen.getByText('src/index.ts')).toBeInTheDocument();
			expect(screen.getByText('src/utils')).toBeInTheDocument();
			expect(screen.getByText('Auto Run')).toBeInTheDocument();
			expect(screen.getByText('src/utils').closest('button')).toHaveClass('ring-1');
		});

		it('shows the no-other-agents guidance for an empty Agents category', () => {
			renderPopover({
				items: [],
				category: 'agents' as MentionCategory,
				filter: '',
			});
			expect(
				screen.getByText(/No other agents available - open another agent in the Left Bar/)
			).toBeInTheDocument();
		});

		describe('SSH pill on agent rows', () => {
			const agentItems: MentionPickerItem[] = [
				{
					kind: 'agent',
					value: '@Local ',
					displayText: 'Local',
					targetSessionId: 'local',
					toolType: 'claude-code',
					isSshRemote: false,
					sshRemoteId: null,
					score: 1,
				},
				{
					kind: 'agent',
					value: '@Remote ',
					displayText: 'Remote',
					targetSessionId: 'remote',
					toolType: 'claude-code',
					isSshRemote: true,
					sshRemoteId: 'remote-1',
					score: 1,
				},
			];

			function renderAgents() {
				return renderPopover({
					items: agentItems,
					category: 'agents' as MentionCategory,
					filter: '',
				});
			}

			it('labels an SSH agent with its resolved remote name and leaves local rows bare', async () => {
				vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValueOnce({
					success: true,
					configs: [{ id: 'remote-1', name: 'build-box' }],
				} as never);

				renderAgents();

				await waitFor(() => expect(screen.getByText('build-box')).toBeInTheDocument());

				// The pill lives on the SSH row only - absence means local.
				const remoteRow = screen.getByText('Remote').closest('button')!;
				const localRow = screen.getByText('Local').closest('button')!;
				expect(remoteRow).toContainElement(screen.getByText('build-box'));
				expect(localRow.textContent).not.toMatch(/build-box|SSH/);
			});

			it('falls back to a generic SSH label when the remote name cannot be resolved', async () => {
				vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValueOnce({
					success: true,
					configs: [],
				} as never);

				renderAgents();

				// Still marked remote: a missing name must never read as "local".
				await waitFor(() => expect(screen.getByText('SSH')).toBeInTheDocument());
				expect(screen.getByText('Remote').closest('button')).toContainElement(
					screen.getByText('SSH')
				);
			});
		});

		it('replaces @filter on click and clears mention state', async () => {
			const textarea = document.createElement('textarea');
			textarea.value = 'open @src now';
			const focus = vi.spyOn(textarea, 'focus');
			const setInputValue = vi.fn((value: string) => {
				textarea.value = value;
			});
			const setOpen = vi.fn();
			const setFilter = vi.fn();
			const setStartIndex = vi.fn();
			const setSelectedIndex = vi.fn();
			renderPopover({
				setInputValue,
				setOpen,
				setFilter,
				setStartIndex,
				setSelectedIndex,
				inputRef: { current: textarea },
			});

			const item = screen.getByText('src/index.ts').closest('button')!;
			fireEvent.mouseEnter(item);
			fireEvent.click(item);
			// The caret is placed in the frame after the controlled value commits.
			await act(async () => {
				await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			});

			expect(setSelectedIndex).toHaveBeenCalledWith(0);
			expect(setInputValue).toHaveBeenCalledWith('open @src/index.ts now');
			expect(setOpen).toHaveBeenCalledWith(false);
			expect(setFilter).toHaveBeenCalledWith('');
			expect(setStartIndex).toHaveBeenCalledWith(-1);
			expect(focus).toHaveBeenCalled();
			expect(textarea.value).toBe('open @src/index.ts now');
			expect(textarea.selectionStart).toBe('open @src/index.ts '.length);
			expect(textarea.selectionEnd).toBe(textarea.selectionStart);
		});
	});
});
describeSourceSuite('TabCompletionPopover', () => {
	describe('TabCompletionPopover', () => {
		const suggestions = [
			{ value: 'ls -la', displayText: 'ls -la', type: 'history' as const },
			{ value: 'git checkout main', displayText: 'main', type: 'branch' as const },
			{ value: 'src/', displayText: 'src', type: 'folder' as const },
		];

		function renderPopover(overrides = {}) {
			return render(
				<TabCompletionPopover
					isOpen
					isShellInput
					isGitRepo
					suggestions={suggestions}
					selectedIndex={0}
					filter="all"
					itemRefs={createItemRefs<HTMLButtonElement>()}
					theme={inputAreaTheme}
					setInputValue={vi.fn()}
					setOpen={vi.fn()}
					setFilter={vi.fn()}
					setSelectedIndex={vi.fn()}
					inputRef={{ current: null }}
					{...overrides}
				/>
			);
		}

		it('renders nothing for a non-shell draft or when closed', () => {
			const { rerender } = renderPopover({ isOpen: false });
			expect(screen.queryByText('Tab Completion')).not.toBeInTheDocument();

			rerender(
				<TabCompletionPopover
					isOpen
					isShellInput={false}
					suggestions={suggestions}
					selectedIndex={0}
					filter="all"
					itemRefs={createItemRefs<HTMLButtonElement>()}
					theme={inputAreaTheme}
					setInputValue={vi.fn()}
					setOpen={vi.fn()}
					setFilter={vi.fn()}
					setSelectedIndex={vi.fn()}
					isGitRepo={false}
					inputRef={{ current: null }}
				/>
			);
			expect(screen.queryByText('Tab Completion')).not.toBeInTheDocument();
		});

		it('renders suggestions and git filter buttons', () => {
			renderPopover({ selectedIndex: 1 });

			expect(screen.getByText('Tab Completion')).toBeInTheDocument();
			expect(screen.getByText('ls -la')).toBeInTheDocument();
			expect(screen.getByText('Branches')).toBeInTheDocument();
			expect(screen.getByText('main').closest('button')).toHaveClass('ring-1');
		});

		it('hides git filters when not in a git repo', () => {
			renderPopover({ isGitRepo: false });

			expect(screen.queryByText('Branches')).not.toBeInTheDocument();
			expect(screen.queryByText('Tags')).not.toBeInTheDocument();
		});

		it('changes filter and resets selected index', () => {
			const setFilter = vi.fn();
			const setSelectedIndex = vi.fn();
			renderPopover({ setFilter, setSelectedIndex });

			fireEvent.click(screen.getByText('Branches'));

			expect(setFilter).toHaveBeenCalledWith('branch');
			expect(setSelectedIndex).toHaveBeenCalledWith(0);
		});

		it('selects suggestion on click and hover', () => {
			const setInputValue = vi.fn();
			const setOpen = vi.fn();
			const setSelectedIndex = vi.fn();
			const focus = vi.fn();
			renderPopover({
				setInputValue,
				setOpen,
				setSelectedIndex,
				inputRef: { current: { focus } as HTMLTextAreaElement },
			});

			const branch = screen.getByText('main').closest('button')!;
			fireEvent.mouseEnter(branch);
			fireEvent.click(branch);

			expect(setSelectedIndex).toHaveBeenCalledWith(1);
			expect(setInputValue).toHaveBeenCalledWith('git checkout main');
			expect(setOpen).toHaveBeenCalledWith(false);
			expect(focus).toHaveBeenCalled();
		});

		it('renders for an AI-mode command-mode draft, with the bang kept on accept', () => {
			// isShellInput is true in AI mode while the draft starts with `!`, and the
			// completed value must stay a runnable bang command.
			const setInputValue = vi.fn();
			renderPopover({
				setInputValue,
				suggestions: [
					{ value: '!git checkout main', displayText: 'main', type: 'branch' as const },
				],
			});

			expect(screen.getByText('Tab Completion')).toBeInTheDocument();
			fireEvent.click(screen.getByText('main').closest('button')!);
			expect(setInputValue).toHaveBeenCalledWith('!git checkout main');
		});

		it('renders filter-specific empty state', () => {
			renderPopover({ suggestions: [], filter: 'branch' });

			expect(screen.getByText('No matching branches')).toBeInTheDocument();
		});
	});
});
describe('commandHistory', () => {
	describe('InputArea commandHistory utils', () => {
		it('prefers shell history in terminal mode', () => {
			const session = createInputAreaSession({
				shellCommandHistory: ['ls -la'],
				aiCommandHistory: ['explain code'],
				commandHistory: ['legacy'],
			} as any);

			expect(getCurrentCommandHistory(session, true)).toEqual(['ls -la']);
		});

		it('falls back to legacy history in terminal mode', () => {
			const session = createInputAreaSession({
				shellCommandHistory: [],
				commandHistory: ['legacy shell'],
			} as any);

			expect(getCurrentCommandHistory(session, true)).toEqual(['legacy shell']);
		});

		it('prefers AI history in AI mode', () => {
			const session = createInputAreaSession({
				aiCommandHistory: ['summarize this'],
				commandHistory: ['legacy'],
			} as any);

			expect(getCurrentCommandHistory(session, false)).toEqual(['summarize this']);
		});

		it('dedupes, filters case-insensitively, reverses, and caps at 10', () => {
			const history = [
				'alpha 1',
				'beta',
				'alpha 1',
				'alpha 2',
				'alpha 3',
				'alpha 4',
				'alpha 5',
				'alpha 6',
				'alpha 7',
				'alpha 8',
				'alpha 9',
				'alpha 10',
				'alpha 11',
			];

			expect(filterCommandHistory(history, 'ALPHA')).toEqual([
				'alpha 11',
				'alpha 10',
				'alpha 9',
				'alpha 8',
				'alpha 7',
				'alpha 6',
				'alpha 5',
				'alpha 4',
				'alpha 3',
				'alpha 2',
			]);
		});
	});
});
