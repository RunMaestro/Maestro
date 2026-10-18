/**
 * The `span` override in the chat component map is the widest blast radius in
 * the Codex directive feature, and the one thing it must do is almost nothing.
 *
 * It runs for EVERY `<span>` in EVERY chat message from EVERY provider - chat
 * renders sanitized raw HTML, so an agent drawing its own span has to keep
 * getting one - and only the handful carrying `data-codex-directive` become a
 * chip or a card. Nothing else in the feature is reached by a non-Codex agent's
 * message, so a regression here is a regression for every user at once, and it
 * would present as spans losing their styling or their text rather than as
 * anything to do with Codex.
 *
 * The other half is the CONTEXT gate. A directive can also arrive as
 * hand-written raw HTML, which skips the remark plugin entirely and with it
 * every guard the plugin applies (no code fences, no user messages). So the
 * gate has to hold at the component too: without a conversation to act in, a
 * git directive must render as inert text rather than as a button that acts on
 * the user's repository.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { mockTheme } from '../../../helpers/mockTheme';

vi.mock('../../../../renderer/hooks/git/useGitAgentActions', () => ({
	useGitAgentActions: () => ({
		isGitRepo: true,
		branch: 'feat-x',
		push: vi.fn(),
		createPR: vi.fn(),
		pushRunning: false,
		prRunning: false,
	}),
	resolveGitCwd: () => '/repo',
	resolveGitSshRemoteId: () => undefined,
}));

vi.mock('../../../../renderer/stores/sessionStore', () => ({
	selectSessionById: () => () => ({ id: 'agent-1', cwd: '/repo', isGitRepo: true }),
	useSessionStore: (selector: (state: unknown) => unknown) => selector({}),
}));

const { createChatMarkdownComponents } =
	await import('../../../../renderer/components/Markdown/chatComponents');

function spanComponent(codexFollowup?: { sessionId: string; tabId: string }) {
	const map = createChatMarkdownComponents({
		theme: mockTheme,
		onCopy: vi.fn(),
		onLinkContextMenu: vi.fn(),
		onFileContextMenu: vi.fn(),
		codexFollowup,
	});
	// The map is typed for react-markdown, which hands every override a `node`.
	// Tests render it directly, so the cast is the seam between the two.
	return map.span as unknown as React.ComponentType<Record<string, unknown>>;
}

describe('chat span override: inert on everything that is not a directive', () => {
	it('renders an ordinary span with its children, class and style intact', () => {
		const Span = spanComponent();
		render(
			<Span className="agent-authored" style={{ color: 'rgb(1, 2, 3)' }} title="hi">
				visible text
			</Span>
		);

		// THE assertion for every non-Codex user of the app: an agent that draws
		// its own span in raw HTML still gets that span, unchanged.
		const el = screen.getByTitle('hi');
		expect(el.tagName).toBe('SPAN');
		expect(el).toHaveTextContent('visible text');
		expect(el).toHaveClass('agent-authored');
		expect(el.getAttribute('style')).toContain('rgb(1, 2, 3)');
	});

	it('renders a span with no props and no children without throwing', () => {
		const Span = spanComponent();
		// `<span></span>` is legal markup and reaches the override with nothing on
		// it. An empty payload check that assumed a string would throw here and
		// take the whole message down with it.
		expect(() => render(<Span />)).not.toThrow();
	});

	it('falls through to a plain span when the directive attributes are malformed', () => {
		const Span = spanComponent({ sessionId: 'agent-1', tabId: 'tab-1' });
		// The attribute is machine-written, but a reader cannot assume it is
		// well-formed just because we wrote it: a truncated payload must render the
		// element rather than throw inside a message.
		render(
			<Span data-codex-directive="codex-followup" data-codex-directive-payload="{not json">
				fallback text
			</Span>
		);

		expect(screen.getByText('fallback text')).toBeInTheDocument();
		expect(screen.queryByTestId('codex-followup-chip')).toBeNull();
	});

	it('draws a chip only when there is a conversation to send into', () => {
		const payload = JSON.stringify({ prompt: 'Do the thing' });

		const WithContext = spanComponent({ sessionId: 'agent-1', tabId: 'tab-1' });
		const { unmount } = render(
			<WithContext
				data-codex-directive="codex-followup"
				data-codex-directive-label="Do it"
				data-codex-directive-payload={payload}
			/>
		);
		expect(screen.getByTestId('codex-followup-chip')).toHaveTextContent('Do it');
		unmount();

		// No context is the user-message and non-Codex case. The agent's label is
		// still shown - it is the part written for a reader - but there is nothing
		// to press.
		const NoContext = spanComponent();
		render(
			<NoContext
				data-codex-directive="codex-followup"
				data-codex-directive-label="Do it"
				data-codex-directive-payload={payload}
			/>
		);
		expect(screen.queryByTestId('codex-followup-chip')).toBeNull();
		expect(screen.getByText('Do it')).toBeInTheDocument();
	});

	it('refuses a git action card when there is no conversation to act in', () => {
		// The one that matters. Hand-written raw HTML skips the remark plugin and
		// every guard it applies, so this is the only thing standing between a
		// directive in a USER message and a live button that pushes a repository.
		const NoContext = spanComponent();
		render(
			<NoContext
				data-codex-directive="git-push"
				data-codex-directive-label="Push it"
				data-codex-directive-payload={JSON.stringify({ branch: 'feat-x' })}
			/>
		);

		expect(screen.queryByTestId('codex-git-action')).toBeNull();
		expect(screen.queryByTestId('codex-git-action-button')).toBeNull();
		expect(screen.getByText('Push it')).toBeInTheDocument();
	});

	it('renders the label as text for a known name nothing draws yet', () => {
		const Span = spanComponent({ sessionId: 'agent-1', tabId: 'tab-1' });
		render(
			<Span
				data-codex-directive="codex-inline-vis"
				data-codex-directive-label="Chart"
				data-codex-directive-payload="{}"
			/>
		);

		// The plugin emits no children for a directive, so returning the plain span
		// here would delete the offer from the message entirely.
		expect(screen.getByText('Chart')).toBeInTheDocument();
	});
});
