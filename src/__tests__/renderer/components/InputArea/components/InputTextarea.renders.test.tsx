/**
 * Render budget of the AI composer's textarea (CLAUDE-PERFORMANCE.md).
 *
 * A keystroke re-renders it once and only once, and a streaming flush from
 * another agent (which replaces `sessionStore.sessions`) does not re-render it
 * at all while the draft holds no `@`. With an `@` it has to, because the
 * mention chips read the roster. This agent's own flush, which replaces its
 * Session object, does not re-render it either, since the adapter takes the
 * agent's id, name and provider rather than the Session.
 *
 * Counted at the shared ComposerTextarea, through a pass-through wrapper that
 * renders whenever the AI adapter does: the adapter has no other child, so the
 * wrapper's count is the adapter's render count.
 */

import type { ComponentProps, RefObject } from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InputTextarea } from '../../../../../renderer/components/InputArea/components/InputTextarea';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createInputAreaSession, inputAreaTheme } from '../_fixtures';

const counter = vi.hoisted(() => ({ renders: 0 }));
vi.mock('../../../../../renderer/components/ChatComposer', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../../../renderer/components/ChatComposer')>();
	const Real = actual.ComposerTextarea;
	return {
		...actual,
		ComposerTextarea: (props: ComponentProps<typeof Real>) => {
			counter.renders += 1;
			return <Real {...props} />;
		},
	};
});

const session = createInputAreaSession();
const otherAgent = createInputAreaSession({ id: 'session-2', name: 'Other' });

function renderCounted(initialValue: string) {
	const inputRef: RefObject<HTMLTextAreaElement> = { current: null };
	const handlers = {
		onInputFocus: vi.fn(),
		onChange: vi.fn(),
		handleInputKeyDown: vi.fn(),
		handlePaste: vi.fn(),
		handleDrop: vi.fn(),
	};
	const tree = (value: string, agent = session) => (
		<InputTextarea
			agentId={agent.id}
			agentName={agent.name}
			toolType={agent.toolType}
			theme={inputAreaTheme}
			isTerminalMode={false}
			isCommandModeDraft={false}
			isAiCommandDraft={false}
			awaitingAiCommand={false}
			inputValue={value}
			spellCheckEnabled={false}
			inputRef={inputRef}
			{...handlers}
		/>
	);
	const view = render(tree(initialValue));
	counter.renders = 0;
	return {
		type: (value: string) => view.rerender(tree(value)),
		/** InputArea re-rendering with this agent's Session replaced by a streaming flush. */
		ownFlush: (value: string) => view.rerender(tree(value, { ...session })),
		renders: () => counter.renders,
	};
}

/** What a streaming flush from another agent does to the store. */
function flushOtherAgent() {
	act(() => {
		useSessionStore.setState((s) => ({
			sessions: s.sessions.map((x) => (x.id === otherAgent.id ? { ...x } : x)),
		}));
	});
}

describe('InputTextarea render budget', () => {
	beforeEach(() => {
		useSessionStore.setState({ sessions: [session, otherAgent], groups: [] } as never);
	});

	it('renders once per keystroke', () => {
		const composer = renderCounted('hel');
		composer.type('hell');
		expect(composer.renders()).toBe(1);
		composer.type('hello');
		expect(composer.renders()).toBe(2);
	});

	it("does not render on another agent's streaming flush while the draft has no @", () => {
		const composer = renderCounted('no mention here');
		flushOtherAgent();
		flushOtherAgent();
		expect(composer.renders()).toBe(0);
	});

	it("does not render when this agent's own Session object is replaced", () => {
		const composer = renderCounted('ask @Other');
		composer.ownFlush('ask @Other');
		expect(composer.renders()).toBe(0);
	});

	it('renders once per flush while the draft has an @, for the mention roster', () => {
		const composer = renderCounted('ask @Other');
		flushOtherAgent();
		expect(composer.renders()).toBe(1);
	});
});
