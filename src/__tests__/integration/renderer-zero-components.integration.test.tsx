import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutoRunStats, Group, Theme } from '../../renderer/types';

vi.mock('../../renderer/utils/ids', () => ({
	generateId: () => 'fixed-id',
}));

const settingsMocks = vi.hoisted(() => ({
	activeThemeId: 'dracula',
	setActiveThemeId: vi.fn(),
	customThemeColors: {},
	setCustomThemeColors: vi.fn(),
	customThemeBaseId: 'dracula',
	setCustomThemeBaseId: vi.fn(),
}));

vi.mock('../../renderer/hooks', () => ({
	useSettings: () => settingsMocks,
}));

vi.mock('../../renderer/components/CustomThemeBuilder', () => ({
	CustomThemeBuilder: () => <div data-testid="custom-theme-builder" />,
}));

vi.mock('../../renderer/components/ui', async () => {
	const { forwardRef } = await vi.importActual<typeof import('react')>('react');

	return {
		Modal: MockModal,
		ModalFooter: MockModalFooter,
		EmojiPickerField: MockEmojiPickerField,
		FormInput: forwardRef<HTMLInputElement, MockFormInputProps>(MockFormInput),
	};
});

vi.mock('../../renderer/components/ui/Modal', () => ({
	Modal: MockModal,
	ModalFooter: MockModalFooter,
}));

vi.mock('../../renderer/components/ui/FormInput', async () => {
	const { forwardRef } = await vi.importActual<typeof import('react')>('react');

	return {
		FormInput: forwardRef<HTMLInputElement, MockFormInputProps>(MockFormInput),
	};
});

import { CreateGroupModal } from '../../renderer/components/CreateGroupModal';
import { DeleteGroupChatModal } from '../../renderer/components/DeleteGroupChatModal';
import { RenameGroupChatModal } from '../../renderer/components/RenameGroupChatModal';
import { RenameGroupModal } from '../../renderer/components/RenameGroupModal';
import { RenameTabModal } from '../../renderer/components/RenameTabModal';
import { ThemeTab } from '../../renderer/components/Settings/tabs/ThemeTab';
import { queueAchievement, useAchievements } from '../../renderer/hooks/batch/useAchievements';

interface MockModalProps {
	title: string;
	onClose: () => void;
	footer?: React.ReactNode;
	children: React.ReactNode;
}

function MockModal({ title, onClose, footer, children }: MockModalProps) {
	return (
		<section aria-label={title}>
			<h1>{title}</h1>
			<button type="button" onClick={onClose}>
				Close
			</button>
			<div>{children}</div>
			<div>{footer}</div>
		</section>
	);
}

interface MockModalFooterProps {
	onCancel: () => void;
	onConfirm: () => void;
	confirmLabel: string;
	confirmDisabled?: boolean;
	confirmButtonRef?: React.RefObject<HTMLButtonElement>;
	destructive?: boolean;
}

function MockModalFooter({
	onCancel,
	onConfirm,
	confirmLabel,
	confirmDisabled,
	confirmButtonRef,
	destructive,
}: MockModalFooterProps) {
	return (
		<div>
			<button type="button" onClick={onCancel}>
				Cancel
			</button>
			<button
				type="button"
				ref={confirmButtonRef}
				onClick={onConfirm}
				disabled={confirmDisabled}
				data-destructive={destructive ? 'true' : 'false'}
			>
				{confirmLabel}
			</button>
			{confirmDisabled && (
				<button type="button" data-testid="disabled-confirm-invoker" onClick={onConfirm} hidden>
					Invoke disabled confirm
				</button>
			)}
		</div>
	);
}

interface MockEmojiPickerFieldProps {
	value: string;
	onChange: (value: string) => void;
}

function MockEmojiPickerField({ value, onChange }: MockEmojiPickerFieldProps) {
	return (
		<button type="button" aria-label="Choose emoji" onClick={() => onChange('🚀')}>
			{value}
		</button>
	);
}

interface MockFormInputProps {
	label?: string;
	value?: string;
	onChange: (value: string) => void;
	onSubmit?: () => void;
	placeholder?: string;
}

function MockFormInput(
	{ label, value = '', onChange, onSubmit, placeholder }: MockFormInputProps,
	ref: React.ForwardedRef<HTMLInputElement>
) {
	return (
		<label>
			{label ?? placeholder ?? 'Input'}
			<input
				ref={ref}
				aria-label={label ?? placeholder ?? 'Input'}
				value={value}
				placeholder={placeholder}
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === 'Enter') {
						onSubmit?.();
					}
				}}
			/>
		</label>
	);
}

const theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#222222',
		bgActivity: '#333333',
		border: '#444444',
		textMain: '#eeeeee',
		textDim: '#999999',
		accent: '#8b5cf6',
		accentDim: '#8b5cf640',
		accentText: '#a78bfa',
		accentForeground: '#ffffff',
		success: '#10b981',
		warning: '#f59e0b',
		error: '#ef4444',
	},
} as Theme;

function stats(overrides: Partial<AutoRunStats> = {}): AutoRunStats {
	return {
		cumulativeTimeMs: 0,
		longestRunMs: 0,
		longestRunTimestamp: 0,
		totalRuns: 0,
		currentBadgeLevel: 0,
		lastBadgeUnlockLevel: 0,
		lastAcknowledgedBadgeLevel: 0,
		badgeHistory: [],
		...overrides,
	};
}

describe('renderer zero-coverage components integration', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('creates a group with normalized name, selected emoji, and callback', () => {
		const setGroups = vi.fn();
		const onClose = vi.fn();
		const onGroupCreated = vi.fn();

		render(
			<CreateGroupModal
				theme={theme}
				onClose={onClose}
				groups={[]}
				setGroups={setGroups}
				onGroupCreated={onGroupCreated}
			/>
		);

		expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
		fireEvent.change(screen.getByLabelText('Group Name'), { target: { value: ' launch team ' } });
		fireEvent.click(screen.getByLabelText('Choose emoji'));
		fireEvent.click(screen.getByRole('button', { name: 'Create' }));

		expect(setGroups).toHaveBeenCalledWith([
			{ id: 'group-fixed-id', name: 'LAUNCH TEAM', emoji: '🚀', collapsed: false },
		]);
		expect(onGroupCreated).toHaveBeenCalledWith('group-fixed-id');
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('creates a group without requiring the optional creation callback', () => {
		const existingGroup: Group = {
			id: 'group-existing',
			name: 'EXISTING',
			emoji: '📂',
			collapsed: false,
		};
		const setGroups = vi.fn();
		const onClose = vi.fn();

		render(
			<CreateGroupModal
				theme={theme}
				onClose={onClose}
				groups={[existingGroup]}
				setGroups={setGroups}
			/>
		);

		fireEvent.change(screen.getByLabelText('Group Name'), { target: { value: ' support ' } });
		fireEvent.click(screen.getByRole('button', { name: 'Create' }));

		expect(setGroups).toHaveBeenCalledWith([
			existingGroup,
			{ id: 'group-fixed-id', name: 'SUPPORT', emoji: '📂', collapsed: false },
		]);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('renames a group through the updater and ignores blank names', () => {
		const groups: Group[] = [
			{ id: 'group-1', name: 'OLD', emoji: '📂', collapsed: false },
			{ id: 'group-2', name: 'OTHER', emoji: '✨', collapsed: true },
		];
		const setGroups = vi.fn();
		const onClose = vi.fn();

		const { rerender } = render(
			<RenameGroupModal
				theme={theme}
				groupId="group-1"
				groupName=" new name "
				setGroupName={vi.fn()}
				groupEmoji="🚀"
				setGroupEmoji={vi.fn()}
				onClose={onClose}
				groups={groups}
				setGroups={setGroups}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
		const updater = setGroups.mock.calls[0][0] as (previous: Group[]) => Group[];
		expect(updater(groups)).toEqual([
			{ id: 'group-1', name: 'NEW NAME', emoji: '🚀', collapsed: false },
			groups[1],
		]);
		expect(onClose).toHaveBeenCalledTimes(1);

		setGroups.mockClear();
		rerender(
			<RenameGroupModal
				theme={theme}
				groupId="group-1"
				groupName="   "
				setGroupName={vi.fn()}
				groupEmoji="🚀"
				setGroupEmoji={vi.fn()}
				onClose={onClose}
				groups={groups}
				setGroups={setGroups}
			/>
		);
		expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();

		setGroups.mockClear();
		onClose.mockClear();
		rerender(
			<RenameGroupModal
				theme={theme}
				groupId=""
				groupName="Valid Name"
				setGroupName={vi.fn()}
				groupEmoji="🚀"
				setGroupEmoji={vi.fn()}
				onClose={onClose}
				groups={groups}
				setGroups={setGroups}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
		expect(setGroups).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('renames tabs using typed value and fallback placeholder text', () => {
		const onRename = vi.fn();
		const onClose = vi.fn();
		const { rerender } = render(
			<RenameTabModal
				theme={theme}
				initialName="Old Tab"
				agentSessionId="abc123-def456"
				onClose={onClose}
				onRename={onRename}
			/>
		);

		expect(screen.getByPlaceholderText('Rename ABC123...')).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText('Rename ABC123...'), {
			target: { value: ' Better Tab ' },
		});
		fireEvent.keyDown(screen.getByLabelText('Rename ABC123...'), { key: 'Enter' });
		expect(onRename).toHaveBeenCalledWith('Better Tab');
		expect(onClose).toHaveBeenCalledTimes(1);

		rerender(<RenameTabModal theme={theme} initialName="" onClose={onClose} onRename={onRename} />);
		expect(screen.getByPlaceholderText('Enter tab name...')).toBeInTheDocument();
	});

	it('renames an open group chat only when the name changes', () => {
		const onRename = vi.fn();
		const onClose = vi.fn();
		const { rerender } = render(
			<RenameGroupChatModal
				theme={theme}
				isOpen={false}
				currentName="Daily Sync"
				onClose={onClose}
				onRename={onRename}
			/>
		);

		expect(screen.queryByText('Rename Group Chat')).not.toBeInTheDocument();

		rerender(
			<RenameGroupChatModal
				theme={theme}
				isOpen
				currentName="Daily Sync"
				onClose={onClose}
				onRename={onRename}
			/>
		);
		expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
		fireEvent.change(screen.getByLabelText('Chat Name'), { target: { value: ' Weekly Sync ' } });
		fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

		expect(onRename).toHaveBeenCalledWith('Weekly Sync');
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('ignores unchanged group chat rename submissions defensively', () => {
		const onRename = vi.fn();
		const onClose = vi.fn();

		render(
			<RenameGroupChatModal
				theme={theme}
				isOpen
				currentName="Daily Sync"
				onClose={onClose}
				onRename={onRename}
			/>
		);

		const renameButton = screen.getByRole('button', { name: 'Rename' });
		expect(renameButton).toBeDisabled();
		fireEvent.click(screen.getByTestId('disabled-confirm-invoker'));

		expect(onRename).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('confirms destructive group chat deletion only when open', () => {
		const onConfirm = vi.fn();
		const onClose = vi.fn();
		const { rerender } = render(
			<DeleteGroupChatModal
				theme={theme}
				isOpen={false}
				groupChatName="Launch Chat"
				onClose={onClose}
				onConfirm={onConfirm}
			/>
		);

		expect(screen.queryByText('Delete Group Chat')).not.toBeInTheDocument();

		rerender(
			<DeleteGroupChatModal
				theme={theme}
				isOpen
				groupChatName="Launch Chat"
				onClose={onClose}
				onConfirm={onConfirm}
			/>
		);
		expect(screen.getByText(/Launch Chat/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Delete' })).toHaveAttribute(
			'data-destructive',
			'true'
		);
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('groups themes by mode and selects the clicked theme', () => {
		const setActiveThemeId = vi.fn();
		settingsMocks.activeThemeId = 'dracula';
		settingsMocks.setActiveThemeId = setActiveThemeId;
		const themes = {
			dracula: theme,
			monokai: {
				...theme,
				id: 'monokai',
				name: 'Monokai',
				colors: { ...theme.colors, bgSidebar: '#272822', bgActivity: '#3e3d32' },
			},
			'github-light': {
				...theme,
				id: 'github-light',
				name: 'GitHub Light',
				mode: 'light',
				colors: { ...theme.colors, bgSidebar: '#ffffff', textMain: '#111111' },
			},
			custom: {
				...theme,
				id: 'custom',
				name: 'Hidden Vibe',
				mode: 'vibe',
			},
		};

		render(<ThemeTab theme={theme} themes={themes} />);

		expect(screen.getByText('dark Mode')).toBeInTheDocument();
		expect(screen.getByText('light Mode')).toBeInTheDocument();
		expect(screen.getByText('Dracula')).toBeInTheDocument();
		expect(screen.getByText('Monokai')).toBeInTheDocument();
		expect(screen.getByText('GitHub Light')).toBeInTheDocument();
		expect(screen.queryByText('Hidden Vibe')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /GitHub Light/ }));
		expect(setActiveThemeId).toHaveBeenCalledWith('github-light');
	});

	it('calculates AutoRun achievements and queues pending achievement updates', () => {
		const { result, rerender } = renderHook(({ value }) => useAchievements(value), {
			initialProps: {
				value: stats({
					cumulativeTimeMs: 60 * 60 * 1000,
					longestRunMs: 30 * 60 * 1000,
					totalRuns: 3,
				}),
			},
		});

		expect(result.current.state.totalRuns).toBe(3);
		expect(result.current.state.currentBadge?.level).toBeGreaterThan(0);
		expect(result.current.getBadgeByLevel(1)?.level).toBe(1);
		expect(result.current.getBadgeByLevel(999)).toBeUndefined();
		expect(result.current.pendingAchievements).toEqual([]);

		rerender({
			value: stats({
				cumulativeTimeMs: 0,
				longestRunMs: 0,
				totalRuns: 0,
			}),
		});
		expect(result.current.state.currentBadge).toBeNull();

		act(() => result.current.dismissAchievement());
		expect(result.current.pendingAchievements).toEqual([]);

		const setPendingAchievements = vi.fn();
		const achievement = { type: 'new_record' as const, elapsedTimeMs: 1234 };
		queueAchievement(setPendingAchievements, achievement);
		const updater = setPendingAchievements.mock.calls[0][0] as (previous: unknown[]) => unknown[];
		expect(updater([])).toEqual([achievement]);
	});
});
