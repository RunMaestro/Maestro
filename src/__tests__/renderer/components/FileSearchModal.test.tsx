import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { flattenPreviewableFiles } from '../../../renderer/components/FileSearchModal';
import type { FileNode } from '../../../renderer/types/fileTree';
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { TerminalSearchBar } from '../../../renderer/components/TerminalSearchBar';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../helpers/mockTheme';
import React from 'react';
import { SessionListItem } from '../../../renderer/components/SessionListItem';
import type { ClaudeSession } from '../../../renderer/hooks/agent/useSessionViewer';
import { JsonlViewer } from '../../../renderer/components/JsonlViewer';
import { act } from '@testing-library/react';
import { cleanup } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import { afterEach } from 'vitest';
import { HostFolderPicker } from '../../../renderer/components/HostFolderPicker';
import { finishHostFolderSelection } from '../../../web-desktop/remote-file-dialog';
import { selectHostFolder } from '../../../web-desktop/remote-file-dialog';
import { selectHostSaveFile } from '../../../web-desktop/remote-file-dialog';
import { beforeEach } from 'vitest';
import { NotificationsPanel } from '../../../renderer/components/NotificationsPanel';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { SidebarActions } from '../../../renderer/components/SessionList/SidebarActions';
import { useFeedbackDraftStore } from '../../../renderer/stores/feedbackDraftStore';
import type { Theme } from '../../../renderer/types';
import type { Shortcut } from '../../../renderer/types';
import { SessionItem } from '../../../renderer/components/SessionItem';
import { createMockSession } from '../../helpers/mockSession';
__maestroMicrobenchDescribe('FileSearchModal', () => {
	// Reusable test tree:
	// src/
	//   components/
	//     App.tsx
	//     Modal.tsx
	//   utils/
	//     helpers.ts
	//   index.ts
	// docs/
	//   README.md
	// package.json
	// image.png
	// binary.exe  (not previewable)
	const testTree: FileNode[] = [
		{
			name: 'src',
			type: 'folder',
			children: [
				{
					name: 'components',
					type: 'folder',
					children: [
						{ name: 'App.tsx', type: 'file' },
						{ name: 'Modal.tsx', type: 'file' },
					],
				},
				{
					name: 'utils',
					type: 'folder',
					children: [{ name: 'helpers.ts', type: 'file' }],
				},
				{ name: 'index.ts', type: 'file' },
			],
		},
		{
			name: 'docs',
			type: 'folder',
			children: [{ name: 'README.md', type: 'file' }],
		},
		{ name: 'package.json', type: 'file' },
		{ name: 'image.png', type: 'file' },
		{ name: 'binary.exe', type: 'file' },
	];

	describe('flattenPreviewableFiles', () => {
		it('returns every previewable file in the tree regardless of depth', () => {
			const result = flattenPreviewableFiles(testTree);
			const paths = result.map((f) => f.fullPath);

			expect(paths).toContain('src/components/App.tsx');
			expect(paths).toContain('src/components/Modal.tsx');
			expect(paths).toContain('src/utils/helpers.ts');
			expect(paths).toContain('src/index.ts');
			expect(paths).toContain('docs/README.md');
			expect(paths).toContain('package.json');
			expect(paths).toContain('image.png');
			// binary.exe is not previewable
			expect(paths).not.toContain('binary.exe');
			expect(result).toHaveLength(7);
		});

		it('excludes non-previewable files', () => {
			const tree: FileNode[] = [
				{ name: 'readme.md', type: 'file' },
				{ name: 'program.exe', type: 'file' },
				{ name: 'data.bin', type: 'file' },
				{ name: 'archive.tar.gz', type: 'file' },
			];
			const result = flattenPreviewableFiles(tree);
			expect(result).toHaveLength(1);
			expect(result[0].fullPath).toBe('readme.md');
		});

		it('includes playable audio and video', () => {
			const tree: FileNode[] = [
				{ name: 'theme.mp3', type: 'file' },
				{ name: 'demo.mp4', type: 'file' },
				// Chromium cannot demux mkv, so it is deliberately not listed
				{ name: 'raw.mkv', type: 'file' },
			];
			const paths = flattenPreviewableFiles(tree).map((f) => f.fullPath);
			expect(paths).toEqual(['theme.mp3', 'demo.mp4']);
		});

		it('sets correct depth values', () => {
			const result = flattenPreviewableFiles(testTree);
			const appFile = result.find((f) => f.fullPath === 'src/components/App.tsx');
			const indexFile = result.find((f) => f.fullPath === 'src/index.ts');
			const rootFile = result.find((f) => f.fullPath === 'package.json');

			expect(rootFile?.depth).toBe(0);
			expect(indexFile?.depth).toBe(1);
			expect(appFile?.depth).toBe(2);
		});
	});
});
__maestroMicrobenchDescribe('TerminalSearchBar', () => {
	function setup() {
		const onSearchNext = vi.fn(() => true);
		const onSearchPrevious = vi.fn(() => true);
		render(
			<LayerStackProvider>
				<TerminalSearchBar
					theme={mockTheme}
					isOpen={true}
					onClose={vi.fn()}
					onSearch={vi.fn(() => true)}
					onSearchNext={onSearchNext}
					onSearchPrevious={onSearchPrevious}
				/>
			</LayerStackProvider>
		);
		const input = screen.getByPlaceholderText('Search...');
		fireEvent.change(input, { target: { value: 'needle' } });
		return { input, onSearchNext, onSearchPrevious };
	}

	describe('TerminalSearchBar Enter', () => {
		it('moves to the next match on Enter and the previous one on Shift+Enter', () => {
			const { input, onSearchNext, onSearchPrevious } = setup();

			expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
			expect(onSearchNext).toHaveBeenCalledTimes(1);

			expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })).toBe(false);
			expect(onSearchPrevious).toHaveBeenCalledTimes(1);
		});

		it('leaves Enter to the input method during an IME composition', () => {
			const { input, onSearchNext, onSearchPrevious } = setup();

			for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
				expect(fireEvent.keyDown(input, { key: 'Enter', ...ime })).toBe(true);
				expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true, ...ime })).toBe(true);
			}

			expect(onSearchNext).not.toHaveBeenCalled();
			expect(onSearchPrevious).not.toHaveBeenCalled();
		});
	});
});
__maestroMicrobenchDescribe('SessionListItem.relay', () => {
	const session: ClaudeSession = {
		sessionId: 'provider-1',
		projectPath: '/project',
		timestamp: '2026-10-04T00:00:00Z',
		modifiedAt: '2026-10-04T00:00:00Z',
		firstMessage: 'Hello',
		messageCount: 2,
		sizeBytes: 200,
		inputTokens: 1,
		outputTokens: 1,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		durationSeconds: 1,
	};

	describe('SessionListItem origin', () => {
		it('shows Relay for a Relay session and retains CLI for an unattributed provider session', () => {
			const props = {
				isSelected: false,
				isStarred: false,
				activeAgentSessionId: null,
				isRenaming: false,
				renameValue: '',
				searchMode: 'title' as const,
				theme: mockTheme,
				selectedItemRef: React.createRef<HTMLButtonElement | HTMLDivElement>(),
				renameInputRef: React.createRef<HTMLInputElement>(),
				onSessionClick: vi.fn(),
				onToggleStar: vi.fn(),
				onQuickResume: vi.fn(),
				onStartRename: vi.fn(),
				onRenameChange: vi.fn(),
				onSubmitRename: vi.fn(),
				onCancelRename: vi.fn(),
			};
			const view = render(<SessionListItem {...props} session={{ ...session, origin: 'relay' }} />);
			expect(screen.getByText('Relay')).toBeInTheDocument();
			expect(screen.queryByText('CLI')).not.toBeInTheDocument();
			view.rerender(<SessionListItem {...props} session={session} />);
			expect(screen.getByText('CLI')).toBeInTheDocument();
		});
	});
});
__maestroMicrobenchDescribe('JsonlViewer', () => {
	// lucide-react icons are auto-mocked globally in src/__tests__/setup.ts

	const TABULAR_JSONL = '{"name":"alpha","size":1}\n{"name":"beta","size":2}';

	describe('JsonlViewer', () => {
		describe('scroll container', () => {
			it('pins the table header inside the content area that scrolls both axes', () => {
				// A horizontal-only wrapper around the table would be the header's
				// nearest scrolling ancestor while never scrolling vertically, so the
				// header would scroll away with the rows.
				render(<JsonlViewer content={TABULAR_JSONL} theme={mockTheme} />);

				const header = screen.getByText('name').closest('th');
				expect(header).toHaveStyle({ position: 'sticky', top: '0px' });
				const scroller = header?.closest('[data-preview-scroller]');
				expect(scroller).toHaveClass('overflow-auto');
				expect(header?.closest('.overflow-x-auto')).toBeNull();
			});
		});
	});
});
__maestroMicrobenchDescribe('HostFolderPicker', () => {
	// This fixture deliberately speaks Windows paths even when the test runner does not.
	async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
		if (channel === 'fs:directoryInfo') {
			const path = args[0] ?? 'D:\\host-home';
			if (path === 'bad-path') throw new Error('Host directory not found');
			return { path, parent: 'D:\\', roots: ['D:\\'] };
		}
		if (channel === 'fs:readDir')
			return args[0] === 'D:\\host-home'
				? [
						{ name: 'project', path: 'D:\\host-home\\project', isDirectory: true, isFile: false },
						{
							name: 'private.txt',
							path: 'D:\\host-home\\private.txt',
							isDirectory: false,
							isFile: true,
						},
					]
				: [];
		throw new Error(`Unexpected host method ${channel}`);
	}
	function mount() {
		render(
			<LayerStackProvider>
				<HostFolderPicker theme={mockTheme} />
			</LayerStackProvider>
		);
	}
	afterEach(() => {
		cleanup();
		finishHostFolderSelection(null);
	});

	describe('host folder picker', () => {
		it('browses directories and accepts the exact host path rather than client separators', async () => {
			mount();
			let selected!: Promise<string | null>;
			act(() => {
				selected = selectHostFolder(invoke);
			});
			fireEvent.click(await screen.findByRole('button', { name: 'project' }));
			await waitFor(() =>
				expect(screen.getByLabelText('Absolute host directory path')).toHaveValue(
					'D:\\host-home\\project'
				)
			);
			expect(screen.queryByText('private.txt')).toBeNull();
			fireEvent.click(screen.getByRole('button', { name: 'Select this host directory' }));
			await expect(selected).resolves.toBe('D:\\host-home\\project');
		});

		it('cancels through Escape without selecting any host path', async () => {
			mount();
			let selected!: Promise<string | null>;
			act(() => {
				selected = selectHostFolder(invoke);
			});
			await screen.findByRole('button', { name: 'project' });
			fireEvent.keyDown(window, { key: 'Escape' });
			await expect(selected).resolves.toBeNull();
		});

		it('rejects a save-name traversal and accepts a valid host file name after correction', async () => {
			mount();
			let selected!: Promise<string | null>;
			act(() => {
				selected = selectHostSaveFile(invoke, { defaultPath: 'report.csv' });
			});
			await screen.findByRole('button', { name: 'project' });
			fireEvent.change(screen.getByLabelText('File name on host'), {
				target: { value: '..\\outside.csv' },
			});
			fireEvent.click(screen.getByRole('button', { name: 'Save on host' }));
			expect(await screen.findByRole('alert')).toHaveTextContent('not a path');
			fireEvent.change(screen.getByLabelText('File name on host'), {
				target: { value: 'report.csv' },
			});
			fireEvent.click(screen.getByRole('button', { name: 'Save on host' }));
			await expect(selected).resolves.toBe('D:\\host-home\\report.csv');
		});

		it('does not accept the previously listed directory after a failed navigation', async () => {
			mount();
			act(() => {
				void selectHostFolder(invoke);
			});
			await screen.findByRole('button', { name: 'project' });
			fireEvent.change(screen.getByLabelText('Absolute host directory path'), {
				target: { value: 'bad-path' },
			});
			fireEvent.click(screen.getByRole('button', { name: 'Go' }));
			expect(await screen.findByRole('alert')).toHaveTextContent('not found');
			expect(screen.getByRole('button', { name: 'Select this host directory' })).toBeDisabled();
		});
	});
});
__maestroMicrobenchDescribe('NotificationsPanel', () => {
	function renderPanel(onConfigureNotificationShortcut = vi.fn()) {
		render(
			<NotificationsPanel
				osNotificationsEnabled
				setOsNotificationsEnabled={vi.fn()}
				audioFeedbackEnabled={false}
				setAudioFeedbackEnabled={vi.fn()}
				audioFeedbackCommand="say"
				setAudioFeedbackCommand={vi.fn()}
				toastDuration={20}
				setToastDuration={vi.fn()}
				toastWidth="dynamic"
				setToastWidth={vi.fn()}
				toastPosition="bottom-right"
				setToastPosition={vi.fn()}
				idleNotificationEnabled={false}
				setIdleNotificationEnabled={vi.fn()}
				idleNotificationCommand=""
				setIdleNotificationCommand={vi.fn()}
				onConfigureNotificationShortcut={onConfigureNotificationShortcut}
				theme={mockTheme}
			/>
		);
		return onConfigureNotificationShortcut;
	}

	describe('NotificationsPanel - notification center', () => {
		beforeEach(() => {
			useSettingsStore.setState(useSettingsStore.getInitialState(), true);
		});

		it('is off by default, with every inbox option ghosted and inert', () => {
			const setLarge = vi.fn();
			useSettingsStore.setState({ setNotificationCenterLarge: setLarge });
			const configure = renderPanel();

			const options = screen.getByTestId('notification-center-options');
			expect(options).toHaveClass('opacity-50');
			expect(options).toHaveAttribute('aria-disabled', 'true');

			fireEvent.click(screen.getByText('Use a larger notification center'));
			expect(setLarge).not.toHaveBeenCalled();
			const link = screen.getByRole('button', { name: /Configure notification shortcut/ });
			expect(link).toBeDisabled();
			fireEvent.click(link);
			expect(configure).not.toHaveBeenCalled();
		});

		it('turns the notification center on from its master toggle', () => {
			const setEnabled = vi.fn();
			useSettingsStore.setState({ setNotificationCenterEnabled: setEnabled });
			renderPanel();

			fireEvent.click(screen.getByText('Enable notification center'));
			expect(setEnabled).toHaveBeenCalledWith(true);
		});

		it('un-ghosts and enables the inbox options once it is on', () => {
			const setLarge = vi.fn();
			useSettingsStore.setState({
				notificationCenterEnabled: true,
				setNotificationCenterLarge: setLarge,
			});
			const configure = renderPanel();

			const options = screen.getByTestId('notification-center-options');
			expect(options).not.toHaveClass('opacity-50');
			expect(options).toHaveAttribute('aria-disabled', 'false');

			fireEvent.click(screen.getByText('Use a larger notification center'));
			expect(setLarge).toHaveBeenCalledWith(true);
			fireEvent.click(screen.getByRole('button', { name: /Configure notification shortcut/ }));
			expect(configure).toHaveBeenCalledTimes(1);
		});
	});
});
__maestroMicrobenchDescribe('SidebarActions', () => {
	const theme: Theme = {
		id: 'test-dark',
		name: 'Test Dark',
		mode: 'dark',
		colors: {
			bgMain: '#101322',
			bgSidebar: '#14192d',
			bgActivity: '#1b2140',
			textMain: '#f5f7ff',
			textDim: '#8d96b8',
			accent: '#8b5cf6',
			accentForeground: '#ffffff',
			border: '#2a3154',
			success: '#22c55e',
			warning: '#f59e0b',
			error: '#ef4444',
			info: '#3b82f6',
			bgAccentHover: '#6d28d9',
		},
	};

	const shortcuts = {
		toggleSidebar: { keys: ['Meta', 'b'] },
	} as Record<string, Shortcut>;

	describe('SidebarActions', () => {
		afterEach(() => {
			useFeedbackDraftStore.getState().reset();
		});

		it('renders feedback button next to new agent when sidebar is open', () => {
			render(
				<SidebarActions
					theme={theme}
					leftSidebarOpen={true}
					hasNoSessions={false}
					shortcuts={shortcuts}
					showUnreadAgentsOnly={false}
					hasUnreadAgents={false}
					addNewSession={vi.fn()}
					openFeedback={vi.fn()}
					setLeftSidebarOpen={vi.fn()}
					toggleShowUnreadAgentsOnly={vi.fn()}
				/>
			);

			expect(screen.getByRole('button', { name: /new agent/i })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /feedback/i })).toBeInTheDocument();
		});

		it('opens feedback modal from the sidebar button', () => {
			const openFeedback = vi.fn();

			render(
				<SidebarActions
					theme={theme}
					leftSidebarOpen={true}
					hasNoSessions={false}
					shortcuts={shortcuts}
					showUnreadAgentsOnly={false}
					hasUnreadAgents={false}
					addNewSession={vi.fn()}
					openFeedback={openFeedback}
					setLeftSidebarOpen={vi.fn()}
					toggleShowUnreadAgentsOnly={vi.fn()}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /feedback/i }));

			expect(openFeedback).toHaveBeenCalledTimes(1);
		});

		it('shows a pencil indicator on the feedback button when a draft is minimized', () => {
			useFeedbackDraftStore.getState().setMinimized(true);

			render(
				<SidebarActions
					theme={theme}
					leftSidebarOpen={true}
					hasNoSessions={false}
					shortcuts={shortcuts}
					showUnreadAgentsOnly={false}
					hasUnreadAgents={false}
					addNewSession={vi.fn()}
					openFeedback={vi.fn()}
					setLeftSidebarOpen={vi.fn()}
					toggleShowUnreadAgentsOnly={vi.fn()}
				/>
			);

			// The pip carries a `title`, so it names itself AND shows a tooltip on
			// hover - an aria-label alone was silent to a mouse.
			expect(screen.getByTitle('Feedback draft in progress')).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /feedback/i })).toHaveAttribute(
				'title',
				'Resume feedback draft'
			);
		});
	});
});
__maestroMicrobenchDescribe('SessionItemRename', () => {
	function renderEditing() {
		const onFinishRename = vi.fn();
		render(
			<SessionItem
				variant="flat"
				theme={mockTheme}
				session={createMockSession({ name: 'Reviewer' })}
				isActive={false}
				isKeyboardSelected={false}
				isDragging={false}
				isEditing
				leftSidebarOpen
				onSelect={vi.fn()}
				onDragStart={vi.fn()}
				onContextMenu={vi.fn()}
				onFinishRename={onFinishRename}
				onStartRename={vi.fn()}
				onToggleBookmark={vi.fn()}
			/>
		);
		const input = screen.getByDisplayValue('Reviewer') as HTMLInputElement;
		input.focus();
		return { input, onFinishRename };
	}

	describe('SessionItem rename field', () => {
		it('commits on a normal Enter', () => {
			const { input, onFinishRename } = renderEditing();
			fireEvent.change(input, { target: { value: 'Reviewer 2' } });
			fireEvent.keyDown(input, { key: 'Enter' });
			expect(onFinishRename).toHaveBeenCalledWith('Reviewer 2');
		});

		it('leaves an Enter during an IME composition to the input method (isComposing)', () => {
			const { input, onFinishRename } = renderEditing();
			const handled = fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
			expect(handled).toBe(true);
			expect(onFinishRename).not.toHaveBeenCalled();
			expect(document.activeElement).toBe(input);
		});

		it('leaves an Enter during an IME composition to the input method (keyCode 229)', () => {
			const { input, onFinishRename } = renderEditing();
			const handled = fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
			expect(handled).toBe(true);
			expect(onFinishRename).not.toHaveBeenCalled();
			expect(document.activeElement).toBe(input);
		});
	});
});
