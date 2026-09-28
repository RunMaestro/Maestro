import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtMentionPopover } from '../../../../../renderer/components/InputArea/overlays/AtMentionPopover';
import type {
	MentionCategory,
	MentionPickerItem,
} from '../../../../../renderer/hooks/input/useMentionPicker';
import { ipcCache } from '../../../../../renderer/services/ipcWrapper';
import { createItemRefs, inputAreaTheme } from '../_fixtures';

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

	it('replaces @filter on click and clears mention state', () => {
		const setInputValue = vi.fn();
		const setOpen = vi.fn();
		const setFilter = vi.fn();
		const setStartIndex = vi.fn();
		const setSelectedIndex = vi.fn();
		const focus = vi.fn();
		renderPopover({
			setInputValue,
			setOpen,
			setFilter,
			setStartIndex,
			setSelectedIndex,
			inputRef: { current: { focus } as unknown as HTMLTextAreaElement },
		});

		const item = screen.getByText('src/index.ts').closest('button')!;
		fireEvent.mouseEnter(item);
		fireEvent.click(item);

		expect(setSelectedIndex).toHaveBeenCalledWith(0);
		expect(setInputValue).toHaveBeenCalledWith('open @src/index.ts  now');
		expect(setOpen).toHaveBeenCalledWith(false);
		expect(setFilter).toHaveBeenCalledWith('');
		expect(setStartIndex).toHaveBeenCalledWith(-1);
		expect(focus).toHaveBeenCalled();
	});
});
