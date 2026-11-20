/**
 * Tests for ContinuityPreviewModal - Context: Preview Continuity.
 *
 * The modal is a read-only window onto `useSummarizeAndContinue().previewContinuity`,
 * so the hook is replaced here to drive every state: loading, a preview, a
 * refusal, an answer with no preview, and a rejection. What matters is what the
 * modal will NOT do: render the excerpts as Markdown, keep the preview after it
 * closes, or offer any action beyond Copy and Close. The real hook and planner
 * run in ContinuityPreviewModal.integration.test.tsx.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const { previewMock, copyMock, flashMock, captureMock } = vi.hoisted(() => ({
	previewMock: vi.fn(),
	copyMock: vi.fn(),
	flashMock: vi.fn(),
	captureMock: vi.fn(),
}));

vi.mock('../../../renderer/hooks/agent/useSummarizeAndContinue', () => {
	const hook = { previewContinuity: previewMock };
	return { useSummarizeAndContinue: () => hook };
});
vi.mock('../../../renderer/utils/clipboard', () => ({ safeClipboardWrite: copyMock }));
vi.mock('../../../renderer/utils/flashCopiedToClipboard', () => ({
	flashCopiedToClipboard: flashMock,
}));
vi.mock('../../../renderer/utils/sentry', () => ({ captureException: captureMock }));

import { ContinuityPreviewModal } from '../../../renderer/components/ContinuityPreviewModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { mockTheme } from '../../helpers/mockTheme';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { TabContextOpResult, TabContinuityPreview } from '../../../shared/tabContextOps';

const TEXT = [
	'Continuity preview of tab tab-1 (claude-code). Read only: nothing was sent, compacted, saved or changed.',
	'',
	'Notices:',
	'- 2 History entries were not used, by reason (another tab: 1, the turn failed: 1).',
	"- Whether the provider compacted this conversation on its own is not known: the preview reads Maestro's transcript, not the provider's.",
	'',
	'Unknown:',
	'- next action: no assistant message states one',
].join('\n');

function previewOf(overrides: Partial<TabContinuityPreview> = {}): TabContinuityPreview {
	return {
		text: TEXT,
		entries: 4,
		synopses: { shown: 0, refused: { 'other-tab': 1, 'failed-turn': 1 } },
		notices: ['2 History entries were not used.'],
		unknowns: ['next action: no assistant message states one'],
		...overrides,
	};
}

const answer = (preview: TabContinuityPreview): TabContextOpResult => ({
	success: true,
	sessionId: 'agent-1',
	tabId: 'tab-1',
	continuity: preview,
});

function Wrapper({ children }: { children: React.ReactNode }) {
	return <LayerStackProvider>{children}</LayerStackProvider>;
}

function setup(props: Partial<React.ComponentProps<typeof ContinuityPreviewModal>> = {}) {
	const onClose = vi.fn();
	const view = render(
		<ContinuityPreviewModal
			theme={mockTheme}
			sessionId="agent-1"
			tabId="tab-1"
			onClose={onClose}
			{...props}
		/>,
		{ wrapper: Wrapper }
	);
	return { onClose, ...view };
}

/** Let the preview promise settle and React flush the state it sets. */
const settle = () => act(async () => {});

const pre = () => screen.getByTestId('continuity-preview-text');
const buttonNames = () =>
	screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim());

beforeEach(() => {
	vi.clearAllMocks();
	previewMock.mockResolvedValue(answer(previewOf()));
	copyMock.mockResolvedValue(true);
	useSessionStore.setState({
		sessions: [
			createMockSession({
				id: 'agent-1',
				aiTabs: [createMockAITab({ id: 'tab-1', name: 'Fix the login redirect' })],
				activeTabId: 'tab-1',
			}),
		],
		activeSessionId: 'agent-1',
	} as never);
});

describe('ContinuityPreviewModal', () => {
	describe('what it reads', () => {
		it('asks for the preview of the tab it was opened for, once', async () => {
			setup();
			await settle();
			expect(previewMock).toHaveBeenCalledTimes(1);
			expect(previewMock).toHaveBeenCalledWith('agent-1', 'tab-1');
		});

		it('shows a loading line until the preview arrives, then exactly its text', async () => {
			let resolve: (r: TabContextOpResult) => void = () => {};
			previewMock.mockReturnValue(new Promise<TabContextOpResult>((r) => (resolve = r)));
			setup();
			expect(screen.getByTestId('continuity-preview-loading')).toBeInTheDocument();
			expect(screen.queryByTestId('continuity-preview-text')).not.toBeInTheDocument();

			resolve(answer(previewOf()));
			await settle();

			expect(screen.queryByTestId('continuity-preview-loading')).not.toBeInTheDocument();
			expect(pre().textContent).toBe(TEXT);
		});

		it('names the tab in the header, and keeps the title for the layer', async () => {
			setup();
			await settle();
			expect(screen.getByText('Context: Preview Continuity')).toBeInTheDocument();
			expect(screen.getByTestId('modal-subtitle').textContent).toContain('Fix the login redirect');
		});

		it('shows the notices, the refused-by-reason counts and the Unknown list from the text', async () => {
			setup();
			await settle();
			const shown = pre().textContent ?? '';
			expect(shown).toContain('Notices:');
			expect(shown).toContain('2 History entries were not used, by reason (another tab: 1');
			expect(shown).toContain('Unknown:');
			expect(shown).toContain('next action: no assistant message states one');
		});

		it('does not ask again on a re-render of the same tab', async () => {
			const { rerender, onClose } = setup();
			await settle();
			rerender(
				<ContinuityPreviewModal
					theme={mockTheme}
					sessionId="agent-1"
					tabId="tab-1"
					onClose={onClose}
				/>
			);
			await settle();
			expect(previewMock).toHaveBeenCalledTimes(1);
		});
	});

	describe('plain text, never Markdown', () => {
		const HOSTILE = [
			'# Heading',
			'**bold** and _italic_',
			'[a link](https://example.com/phish)',
			'![an image](https://example.com/track.png)',
			'<script>window.pwned = true</script>',
			'<img src="x" onerror="window.pwned = true">',
			'```js\nrun()\n```',
		].join('\n');

		it('draws every character as text inside one <pre>, creating no elements from it', async () => {
			previewMock.mockResolvedValue(answer(previewOf({ text: HOSTILE })));
			setup();
			await settle();

			const node = pre();
			expect(node.tagName).toBe('PRE');
			expect(node.textContent).toBe(HOSTILE);
			// No heading, emphasis, link, image or script came out of that text.
			expect(node.children).toHaveLength(0);
			expect(node.querySelector('h1, strong, em, a, img, script, code')).toBeNull();
			expect((window as unknown as { pwned?: boolean }).pwned).toBeUndefined();
		});

		it('removes control characters the sender left in, the way the CLI does before it prints', async () => {
			const dirty = 'ok\u001b[31m red\u001b[0m‮ reversed\r\nline two\u0007';
			previewMock.mockResolvedValue(answer(previewOf({ text: dirty })));
			setup();
			await settle();
			const shown = pre().textContent ?? '';
			expect(shown).not.toMatch(/[\u001b‮\u0007\r]/);
			expect(shown).toContain('line two');
		});

		it('keeps a refusal reason as plain text too', async () => {
			previewMock.mockResolvedValue({
				success: false,
				error: 'Tab t <b>holds</b> another‮ agent',
			});
			setup();
			await settle();
			const error = screen.getByTestId('continuity-preview-error');
			expect(error.children).toHaveLength(0);
			expect(error.textContent).toBe('Tab t <b>holds</b> another agent');
		});
	});

	describe('refusals and failures', () => {
		it('shows the reason a tab was refused, with no preview and nothing to copy', async () => {
			previewMock.mockResolvedValue({
				success: false,
				error: "Tab tab-1 holds another agent's consult, not a conversation of this agent.",
			});
			setup();
			await settle();

			expect(screen.getByTestId('continuity-preview-error').textContent).toContain(
				'holds another agent'
			);
			expect(screen.queryByTestId('continuity-preview-text')).not.toBeInTheDocument();
			expect(screen.getByTestId('continuity-preview-copy')).toBeDisabled();
		});

		it('says so when a refusal carries no reason', async () => {
			previewMock.mockResolvedValue({ success: false });
			setup();
			await settle();
			expect(screen.getByTestId('continuity-preview-error').textContent).toMatch(/refused/i);
		});

		it('says so when the answer has no preview (an older desktop, a malformed reply)', async () => {
			previewMock.mockResolvedValue({ success: true, sessionId: 'agent-1', tabId: 'tab-1' });
			setup();
			await settle();
			expect(screen.getByTestId('continuity-preview-error').textContent).toMatch(/empty/i);
			expect(screen.queryByTestId('continuity-preview-text')).not.toBeInTheDocument();
		});

		it('drops a malformed preview rather than showing a part of it', async () => {
			previewMock.mockResolvedValue({
				success: true,
				continuity: { text: 'partial', entries: 'many', synopses: null },
			});
			setup();
			await settle();
			expect(screen.queryByTestId('continuity-preview-text')).not.toBeInTheDocument();
			expect(screen.getByTestId('continuity-preview-error')).toBeInTheDocument();
		});

		it('reports an unexpected rejection and shows a failure instead of loading forever', async () => {
			const boom = new Error('planner bug');
			previewMock.mockRejectedValue(boom);
			setup();
			await settle();

			expect(captureMock).toHaveBeenCalledTimes(1);
			expect(captureMock).toHaveBeenCalledWith(boom, {
				extra: { operation: 'continuityPreview' },
			});
			expect(screen.queryByTestId('continuity-preview-loading')).not.toBeInTheDocument();
			expect(screen.getByTestId('continuity-preview-error').textContent).toMatch(
				/could not be read/i
			);
		});
	});

	describe('a late answer', () => {
		it('is dropped when the modal closed before it arrived', async () => {
			let resolve: (r: TabContextOpResult) => void = () => {};
			previewMock.mockReturnValue(new Promise<TabContextOpResult>((r) => (resolve = r)));
			const { unmount } = setup();
			unmount();
			// Settling a promise nobody listens for any more must not throw or warn.
			await act(async () => resolve(answer(previewOf())));
			expect(captureMock).not.toHaveBeenCalled();
		});

		it('is dropped when the modal moved to another tab meanwhile', async () => {
			const resolvers: Array<(r: TabContextOpResult) => void> = [];
			previewMock.mockImplementation(
				() => new Promise<TabContextOpResult>((r) => resolvers.push(r))
			);
			const { rerender, onClose } = setup();
			rerender(
				<ContinuityPreviewModal
					theme={mockTheme}
					sessionId="agent-1"
					tabId="tab-2"
					onClose={onClose}
				/>
			);
			expect(previewMock).toHaveBeenCalledTimes(2);
			expect(previewMock).toHaveBeenLastCalledWith('agent-1', 'tab-2');

			// The newer request answers first, then the older one arrives late.
			await act(async () => resolvers[1](answer(previewOf({ text: 'text of tab-2' }))));
			await act(async () => resolvers[0](answer(previewOf({ text: 'text of tab-1' }))));

			expect(pre().textContent).toBe('text of tab-2');
		});
	});

	describe('Copy', () => {
		it('copies exactly the text shown and flashes the standard acknowledgement', async () => {
			setup();
			await settle();
			fireEvent.click(screen.getByTestId('continuity-preview-copy'));
			await settle();

			expect(copyMock).toHaveBeenCalledTimes(1);
			expect(copyMock).toHaveBeenCalledWith(TEXT);
			expect(flashMock).toHaveBeenCalledTimes(1);
		});

		it('does not flash when the clipboard refused the write', async () => {
			copyMock.mockResolvedValue(false);
			setup();
			await settle();
			fireEvent.click(screen.getByTestId('continuity-preview-copy'));
			await settle();

			expect(copyMock).toHaveBeenCalledTimes(1);
			expect(flashMock).not.toHaveBeenCalled();
		});

		it('is disabled while the preview is loading', () => {
			previewMock.mockReturnValue(new Promise(() => {}));
			setup();
			expect(screen.getByTestId('continuity-preview-copy')).toBeDisabled();
		});
	});

	describe('leaving', () => {
		it('closes on Escape', async () => {
			const { onClose } = setup();
			await settle();
			fireEvent.keyDown(window, { key: 'Escape' });
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('closes on the header X and on the footer Close, each once', async () => {
			const { onClose } = setup();
			await settle();
			fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));
			expect(onClose).toHaveBeenCalledTimes(1);
			fireEvent.click(screen.getByRole('button', { name: 'Close' }));
			expect(onClose).toHaveBeenCalledTimes(2);
		});

		it('closes on a click on the backdrop', async () => {
			const { onClose } = setup();
			await settle();
			fireEvent.click(screen.getByTestId('continuity-preview-modal'));
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('tells the user Esc closes and that nothing is saved or sent', async () => {
			setup();
			await settle();
			expect(screen.getByText('Esc closes. Nothing here is saved or sent.')).toBeInTheDocument();
		});
	});

	describe('read only', () => {
		it('offers nothing but Copy and Close: no send, continue, compact or merge', async () => {
			setup();
			await settle();
			expect(buttonNames().sort()).toEqual(['Close', 'Close modal', 'Copy']);
			expect(
				screen.queryByText(/send|continue|compact|merge|start|resume/i, { selector: 'button' })
			).toBeNull();
		});

		it('offers the same two controls on a refusal and while loading', async () => {
			previewMock.mockResolvedValue({ success: false, error: 'No.' });
			setup();
			expect(buttonNames().sort()).toEqual(['Close', 'Close modal', 'Copy']);
			await settle();
			expect(buttonNames().sort()).toEqual(['Close', 'Close modal', 'Copy']);
		});

		it('has no editable field: the preview cannot be changed from here', async () => {
			setup();
			await settle();
			expect(document.querySelector('input, textarea, [contenteditable="true"]')).toBeNull();
		});

		it('writes nothing to the session store: it reads the tab and leaves it alone', async () => {
			const before = useSessionStore.getState().sessions;
			const { onClose } = setup();
			await settle();
			fireEvent.click(screen.getByRole('button', { name: 'Close' }));
			expect(useSessionStore.getState().sessions).toBe(before);
			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});
});
