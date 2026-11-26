import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AtMentionPopover } from '../../../../../renderer/components/InputArea/overlays/AtMentionPopover';
import type {
	MentionCategory,
	MentionPickerItem,
} from '../../../../../renderer/hooks/input/useMentionPicker';
import { ipcCache } from '../../../../../renderer/services/ipcWrapper';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import { AGENT_MODES, createModeSession } from '../../../../helpers';
import { createItemRefs, inputAreaTheme } from '../_fixtures';

type AgentMode = (typeof AGENT_MODES)[number];

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
		// The mode pill's SSH name lookup reads through the shared 30s ipcCache entry, so a
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

	describe('mode parity (local, SSH, hosted)', () => {
		const agentItem: MentionPickerItem = {
			kind: 'agent',
			value: '@Builder ',
			displayText: 'Builder',
			targetSessionId: 'a1',
			toolType: 'claude-code',
			score: 1,
		};

		afterEach(() => {
			useSessionStore.setState({ sessions: [] });
			useSettingsStore.setState({ federationHostedAgents: false });
		});

		/** The agent row's pill text and its markup with the pill taken out. */
		function drawRow(mode: AgentMode) {
			useSessionStore.setState({ sessions: [createModeSession(mode, { id: 'a1' })] });
			const { unmount } = renderPopover({
				items: [agentItem],
				category: 'agents' as MentionCategory,
				filter: '',
			});
			const row = screen.getByText('Builder').closest('button')!;
			const pills = row.querySelectorAll('[data-testid^="federation-badge-"]');
			const pill = pills[0]?.textContent ?? '';
			const clone = row.cloneNode(true) as HTMLElement;
			clone
				.querySelectorAll('[data-testid^="federation-badge-"]')
				.forEach((badge) => badge.parentElement?.remove());
			const html = clone.innerHTML;
			unmount();
			return { pill, count: pills.length, html };
		}

		it('draws the Left Bar mode pill on an agent row and nothing else differs', () => {
			useSettingsStore.setState({ federationHostedAgents: true });
			const [local, ssh, hosted] = AGENT_MODES.map(drawRow);
			expect([local.pill, ssh.pill, hosted.pill]).toEqual(['LOCAL', 'REMOTE', 'HOSTED']);
			expect([local.count, ssh.count, hosted.count]).toEqual([1, 1, 1]);
			expect(local.html).toContain('Builder');
			expect(ssh.html).toBe(local.html);
			expect(hosted.html).toBe(local.html);
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
