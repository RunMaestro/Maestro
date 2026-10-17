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

	it('names where a Run on turn ran in place of the model pill', () => {
		// The agent's own model was not the one asked, so it is not the one shown.
		const { getByTestId, queryByTestId } = renderPills({
			model: 'opus[1m]',
			effort: 'high',
			runOn: 'qwen3:latest · Ollama',
		});
		expect(getByTestId('turn-run-on-pill').textContent).toBe('qwen3:latest · Ollama');
		expect(getByTestId('turn-run-on-pill').getAttribute('title')).toBe(
			'Ran on: qwen3:latest · Ollama'
		);
		expect(getByTestId('turn-run-on-pill').hasAttribute('data-turn-setting-pill')).toBe(true);
		expect(queryByTestId('turn-model-pill')).toBeNull();
		expect(queryByTestId('turn-effort-pill')).not.toBeNull();
	});

	it('renders the Run on pill for a turn with no model or effort of its own', () => {
		const { queryByTestId } = renderPills({ runOn: 'gpt-oss 20B (MXFP4) · Maestro' });
		expect(queryByTestId('turn-run-on-pill')).not.toBeNull();
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

	// A turn sent on the Auto model: one pill says what the router decided and
	// where the turn ran, in the place of the model pill and the Run on pill.
	describe('a turn sent on Auto', () => {
		const ROUTE = {
			tier: 'medium' as const,
			effort: 'high' as const,
			engine: 'Jev (TypeSafe cloud)',
			calibrated: true,
		};

		it('reads the routed tier and the model the turn launched on', () => {
			const { getByTestId } = renderPills({
				model: 'sonnet',
				auto: { status: 'routed', route: ROUTE },
			});
			const pill = getByTestId('turn-auto-pill');
			expect(pill.textContent).toBe('Auto \u2192 medium \u00b7 sonnet');
			// The tooltip names the router that decided.
			expect(pill.getAttribute('title')).toContain('Jev (TypeSafe cloud)');
			expect(pill.hasAttribute('data-turn-setting-pill')).toBe(true);
		});

		it('says the router was off', () => {
			const { getByTestId } = renderPills({
				model: 'sonnet',
				auto: { status: 'router-off', route: { skipped: 'off', detail: 'Model routing is off.' } },
			});
			expect(getByTestId('turn-auto-pill').textContent).toBe('Auto (router off)');
		});

		it('says the router gave no decision', () => {
			const { getByTestId } = renderPills({
				auto: {
					status: 'no-decision',
					route: { skipped: 'timeout', detail: 'The router did not answer in time.' },
				},
			});
			expect(getByTestId('turn-auto-pill').textContent).toBe('Auto (no decision)');
		});

		it('says the session kept its model in place of the tier', () => {
			const { getByTestId } = renderPills({
				model: 'haiku',
				auto: { status: 'routed', route: ROUTE, hold: { model: 'haiku' } },
			});
			expect(getByTestId('turn-auto-pill').textContent).toBe('Auto \u2192 haiku (kept)');
		});

		it('names the Run on target over the model when Auto chose the place', () => {
			const { getByTestId } = renderPills({
				model: 'opus',
				runOn: 'qwen3:latest \u00b7 Ollama',
				auto: { status: 'routed', route: { ...ROUTE, tier: 'low' } },
			});
			expect(getByTestId('turn-auto-pill').textContent).toBe(
				'Auto \u2192 low \u00b7 qwen3:latest \u00b7 Ollama'
			);
		});

		it('takes the place of the model pill and the Run on pill, and keeps the effort pill', () => {
			const { queryByTestId } = renderPills({
				model: 'sonnet',
				effort: 'high',
				runOn: 'qwen3:latest \u00b7 Ollama',
				auto: { status: 'routed', route: ROUTE },
			});
			expect(queryByTestId('turn-auto-pill')).not.toBeNull();
			expect(queryByTestId('turn-model-pill')).toBeNull();
			expect(queryByTestId('turn-run-on-pill')).toBeNull();
			expect(queryByTestId('turn-effort-pill')).not.toBeNull();
		});

		it('renders for a turn with nothing but the stamp', () => {
			// A queued message on Auto has no model, effort or target yet.
			const { getByTestId, queryByTestId } = renderPills({ auto: { status: 'pending' } });
			expect(getByTestId('turn-auto-pill').textContent).toBe('Auto');
			expect(getByTestId('turn-auto-pill').getAttribute('title')).toBe(
				'Auto: waiting for the model router.'
			);
			expect(queryByTestId('turn-effort-pill')).toBeNull();
		});
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
