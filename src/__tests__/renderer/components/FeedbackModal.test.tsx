import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import * as React from 'react';
import { FeedbackModal } from '../../../renderer/components/FeedbackModal';
import type { FeedbackDraft } from '../../../renderer/stores/feedbackDraftStore';
import type { Theme } from '../../../renderer/types';

// Track how many times the (mocked) editor mounts. A remount means the editor
// was rebuilt from the persisted copy, which would discard unsaved edits.
const mockChat = { mountCount: 0 };

// Controllable draft-store stand-in: FeedbackModal reads it both via selector
// hooks and via getState(), so the mock supports both call shapes.
const mockState = {
	isMinimized: false,
	hasDraft: false,
	drafts: [] as FeedbackDraft[],
	resumeDraftId: null as string | null,
	activeDraftId: null as string | null,
	activeDraft: null as FeedbackDraft | null,
	setMinimized: vi.fn(),
	setHasDraft: vi.fn(),
	setActiveDraft: vi.fn(),
	loadDrafts: vi.fn().mockResolvedValue(undefined),
	saveDraft: vi.fn().mockResolvedValue('saved-id'),
	deleteDraft: vi.fn().mockResolvedValue(undefined),
	requestResume: vi.fn(),
	clearResume: vi.fn(),
	reset: vi.fn(),
};

vi.mock('../../../renderer/stores/feedbackDraftStore', () => ({
	useFeedbackDraftStore: Object.assign(
		(selector: (s: typeof mockState) => unknown) => selector(mockState),
		{ getState: () => mockState }
	),
}));

vi.mock('../../../renderer/stores/uiStore', () => ({
	useUIStore: (selector: (s: { setLeftSidebarOpen: () => void }) => unknown) =>
		selector({ setLeftSidebarOpen: vi.fn() }),
}));

vi.mock('../../../renderer/components/ui/Modal', () => ({
	Modal: ({
		children,
		customHeader,
	}: {
		children?: React.ReactNode;
		customHeader?: React.ReactNode;
	}) => (
		<div>
			{customHeader}
			{children}
		</div>
	),
}));

vi.mock('../../../renderer/components/ui/GhostIconButton', () => ({
	GhostIconButton: ({
		children,
		onClick,
		ariaLabel,
		title,
	}: {
		children?: React.ReactNode;
		onClick?: () => void;
		ariaLabel?: string;
		title?: string;
	}) => (
		<button aria-label={ariaLabel} title={title} onClick={onClick}>
			{children}
		</button>
	),
}));

vi.mock('../../../renderer/components/FeedbackChatView', () => ({
	FeedbackChatView: () => {
		React.useEffect(() => {
			mockChat.mountCount += 1;
		}, []);
		return <div data-testid="chat-view" />;
	},
}));

vi.mock('../../../renderer/components/FeedbackDraftsList', () => ({
	FeedbackDraftsList: ({
		drafts,
		onResume,
	}: {
		drafts: FeedbackDraft[];
		onResume: (id: string) => void;
	}) => (
		<div>
			{drafts.map((d) => (
				<button key={d.id} aria-label={`resume-${d.id}`} onClick={() => onResume(d.id)}>
					{d.suggestedName}
				</button>
			))}
		</div>
	),
}));

const theme = {
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
	},
} as Theme;

function makeDraft(id: string): FeedbackDraft {
	return {
		id,
		suggestedName: `Draft ${id}`,
		category: 'general_feedback',
		summary: '',
		confidence: 0,
		agentType: 'claude-code',
		messages: [],
		attachments: [],
		inputDraft: '',
		includeDebugPackage: false,
		createdAt: 1000,
		updatedAt: 1000,
	};
}

function renderModal() {
	return render(
		<FeedbackModal theme={theme} sessions={[]} onClose={vi.fn()} onSwitchToSession={vi.fn()} />
	);
}

describe('FeedbackModal draft resume', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockChat.mountCount = 0;
		mockState.drafts = [];
		mockState.activeDraftId = null;
		mockState.activeDraft = null;
		mockState.resumeDraftId = null;
		mockState.saveDraft.mockResolvedValue('saved-id');
	});

	it('reopening the already-active draft is a no-op (no remount, no save, no resume)', async () => {
		mockState.drafts = [makeDraft('draft-1'), makeDraft('draft-2')];
		mockState.activeDraftId = 'draft-1';
		mockState.activeDraft = makeDraft('draft-1');

		renderModal();
		expect(mockChat.mountCount).toBe(1);

		await act(async () => {
			fireEvent.click(screen.getByLabelText('View saved drafts'));
		});
		await act(async () => {
			fireEvent.click(screen.getByLabelText('resume-draft-1'));
		});

		// The live editor must be left untouched: clicking the active draft must
		// not rebuild it from the persisted copy (which would drop unsaved edits).
		expect(mockChat.mountCount).toBe(1);
		expect(mockState.requestResume).not.toHaveBeenCalled();
		expect(mockState.saveDraft).not.toHaveBeenCalled();
	});

	it('switching to a different draft saves the current one then remounts the editor', async () => {
		mockState.drafts = [makeDraft('draft-1'), makeDraft('draft-2')];
		mockState.activeDraftId = 'draft-1';
		mockState.activeDraft = makeDraft('draft-1');
		mockState.saveDraft.mockResolvedValue('draft-1');

		renderModal();
		expect(mockChat.mountCount).toBe(1);

		await act(async () => {
			fireEvent.click(screen.getByLabelText('View saved drafts'));
		});
		await act(async () => {
			fireEvent.click(screen.getByLabelText('resume-draft-2'));
		});

		expect(mockState.saveDraft).toHaveBeenCalledTimes(1);
		expect(mockState.requestResume).toHaveBeenCalledWith('draft-2');
		await waitFor(() => expect(mockChat.mountCount).toBe(2));
	});
});
