/**
 * The thing being guarded here is that a click on an agent-authored chip does
 * what the user thought it would.
 *
 * Both halves of the chip come from the agent, and nothing checks that the
 * label describes the prompt - so the cases that matter are the ones where the
 * two could diverge without the user noticing: the full prompt has to be
 * reachable, the modifier has to change what a click does, and a chip with
 * nothing behind it must not look pressable.
 */

import type { ComponentProps } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FollowupChip } from '../../../../renderer/components/Markdown/components/FollowupChip';
import { mockTheme } from '../../../helpers/mockTheme';

const PROMPT = 'Design the canonical schema for the events table, then show me the migration.';

function renderChip(overrides: Partial<ComponentProps<typeof FollowupChip>> = {}) {
	const onActivate = vi.fn();
	render(
		<FollowupChip
			label="Design the schema"
			prompt={PROMPT}
			sessionId="session-1"
			tabId="tab-1"
			theme={mockTheme}
			onActivate={onActivate}
			{...overrides}
		/>
	);
	return { onActivate };
}

describe('FollowupChip', () => {
	it('renders the agent-authored label', () => {
		renderChip();
		expect(screen.getByTestId('codex-followup-chip')).toHaveTextContent('Design the schema');
	});

	it('sends on a plain click', () => {
		const { onActivate } = renderChip();

		fireEvent.click(screen.getByTestId('codex-followup-chip'));

		expect(onActivate).toHaveBeenCalledTimes(1);
		expect(onActivate).toHaveBeenCalledWith('send');
	});

	it('prefills on an Alt-click, so an agent-authored prompt can be edited first', () => {
		const { onActivate } = renderChip();

		fireEvent.click(screen.getByTestId('codex-followup-chip'), { altKey: true });

		expect(onActivate).toHaveBeenCalledWith('prefill');
	});

	it('sends on Enter, because a real button is the only keyboard-reachable form', () => {
		const { onActivate } = renderChip();
		const chip = screen.getByTestId('codex-followup-chip');

		expect(chip.tagName).toBe('BUTTON');
		expect(chip).toHaveAttribute('type', 'button');

		// jsdom does not synthesize the click a browser fires for Enter on a
		// button, so the assertion that matters is that the element IS a button
		// (above) plus that its activation path sends.
		fireEvent.keyDown(chip, { key: 'Enter' });
		fireEvent.click(chip, { detail: 0 });

		expect(onActivate).toHaveBeenCalledWith('send');
	});

	it('carries the whole prompt in its accessible name', () => {
		// This is the half of the "always show the prompt" rule that survives
		// without a mouse: HoverTooltip only opens on hover, so a keyboard or
		// screen-reader user reads the prompt here or not at all.
		renderChip();

		const name = screen.getByTestId('codex-followup-chip').getAttribute('aria-label') ?? '';
		expect(name).toContain('Design the schema');
		expect(name).toContain(PROMPT);
	});

	it('shows the full prompt on hover', () => {
		renderChip();

		fireEvent.mouseEnter(screen.getByTestId('codex-followup-chip').parentElement as HTMLElement);

		expect(screen.getByRole('tooltip')).toHaveTextContent(PROMPT);
	});

	it('names the conversation it was drawn in', () => {
		renderChip();

		const chip = screen.getByTestId('codex-followup-chip');
		expect(chip).toHaveAttribute('data-session-id', 'session-1');
		expect(chip).toHaveAttribute('data-tab-id', 'tab-1');
	});

	it('renders plain text with no button when there is no prompt to send', () => {
		const { onActivate } = renderChip({ prompt: '' });

		expect(screen.queryByRole('button')).toBeNull();
		expect(screen.queryByTestId('codex-followup-chip')).toBeNull();
		expect(screen.getByTestId('codex-followup-plain')).toHaveTextContent('Design the schema');
		expect(onActivate).not.toHaveBeenCalled();
	});
});
