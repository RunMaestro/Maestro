/**
 * Tests for TurnSettingPills - the read-only model / effort badges on a turn.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TurnSettingPills } from '../../../../renderer/components/ui/TurnSettingPills';
import { mockTheme } from '../../../helpers/mockTheme';

function renderPills(props: Partial<React.ComponentProps<typeof TurnSettingPills>> = {}) {
	return render(<TurnSettingPills theme={mockTheme} {...props} />);
}

describe('TurnSettingPills', () => {
	it('renders nothing when the turn ran on the agent defaults', () => {
		const { container } = renderPills();
		expect(container.firstElementChild).toBeNull();
	});

	it('omits the pill for whichever value is unset rather than guessing', () => {
		const { queryByTestId } = renderPills({ model: 'opus[1m]' });
		expect(queryByTestId('turn-model-pill')).not.toBeNull();
		expect(queryByTestId('turn-effort-pill')).toBeNull();
	});

	it('marks both pills as readouts the phone stylesheet can retire', () => {
		// They share a footer row with controls that cannot yield width (the
		// queued card's Force Send button and its icon cluster), so the phone
		// block in index.css hides everything carrying this attribute. Dropping
		// it here is invisible in jsdom and reappears as overlapping pills on a
		// 390px screen.
		const { getByTestId } = renderPills({ model: 'opus[1m]', effort: 'high' });
		expect(getByTestId('turn-model-pill').hasAttribute('data-turn-setting-pill')).toBe(true);
		expect(getByTestId('turn-effort-pill').hasAttribute('data-turn-setting-pill')).toBe(true);
	});
});

describe('TurnSettingPills phone rule', () => {
	// The attribute on the JSX and the rule in the stylesheet are the two
	// halves of one behaviour, and nothing in the type system ties them
	// together: jsdom has no layout engine and never applies index.css, so
	// deleting or renaming either side is silent here and reappears as three
	// overlapping groups in a queued card's footer at 390px.
	it('hides every element carrying the attribute at the phone breakpoint', () => {
		const css = readFileSync(resolve(process.cwd(), 'src/renderer/index.css'), 'utf8');
		expect(css).toMatch(
			/html\[data-runtime='web-desktop'\]\[data-bp='xs'\] \[data-turn-setting-pill\]\s*\{\s*display:\s*none;/
		);
	});
});
