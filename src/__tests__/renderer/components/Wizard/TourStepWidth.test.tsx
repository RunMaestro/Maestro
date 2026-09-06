import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TourStep } from '../../../../renderer/components/Wizard/tour/TourStep';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { clearTextMeasurementCache } from '../../../../renderer/utils/measureTextWidth';
import { mockTheme } from '../../../helpers/mockTheme';

/**
 * The tour tooltip reserves width for its navigation row - progress dots on the
 * left, Continue on the right, `justify-between` between them.
 *
 * The reserve used to be raw pixels (`totalSteps * 14 + 170`), tuned at a 14px
 * root. Everything it measures is rem-based (`w-2` dots, `gap-1.5`, `p-5`,
 * `text-sm px-4`), so at a larger interface font - or any Cmd+= zoom - the
 * contents outgrew the width they were given and the row collapsed, putting
 * the button on top of the last few dots.
 */

/** A canvas stub, so measureTextWidth returns something in jsdom. */
function stubCanvas(widthPerChar = 7) {
	const realCreateElement = document.createElement.bind(document);
	vi.spyOn(document, 'createElement').mockImplementation(((tag: string, ...rest: unknown[]) => {
		if (tag === 'canvas') {
			return {
				getContext: () => ({
					font: '',
					measureText: (text: string) => ({ width: text.length * widthPerChar }),
				}),
			} as unknown as HTMLCanvasElement;
		}
		return realCreateElement(tag, ...(rest as []));
	}) as typeof document.createElement);
}

function renderStep(overrides: Record<string, unknown> = {}) {
	const props = {
		theme: mockTheme,
		step: { id: 'agent-sessions', title: 'Agent Sessions', description: 'Body copy.' },
		stepNumber: 9,
		totalSteps: 14,
		spotlight: null,
		onNext: vi.fn(),
		onGoToStep: vi.fn(),
		onSkip: vi.fn(),
		isLastStep: false,
		isTransitioning: false,
		isPositionReady: true,
		...overrides,
	};
	const { container } = render(<TourStep {...(props as never)} />);
	return container;
}

/** The width the tooltip asked for, in px. */
function tooltipWidth(container: HTMLElement): number {
	const el = container.querySelector('[style*="width"]') as HTMLElement | null;
	return el ? parseFloat(el.style.width) : 0;
}

beforeEach(() => {
	clearTextMeasurementCache();
	stubCanvas();
	useSettingsStore.setState({ fontSize: 14, fontZoom: 1, fontFamily: 'Roboto Mono' });
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	clearTextMeasurementCache();
});

describe('TourStep navigation row', () => {
	it('reserves more width as the interface font grows', () => {
		// The defect: a fixed-pixel reserve against rem-based contents.
		const small = tooltipWidth(renderStep());
		cleanup();

		useSettingsStore.setState({ fontSize: 20 });
		clearTextMeasurementCache();
		const large = tooltipWidth(renderStep());

		expect(large).toBeGreaterThan(small);
	});

	it('reserves more width as the zoom grows', () => {
		// Cmd+= scales the root too, so it has to move the reserve as well.
		const unzoomed = tooltipWidth(renderStep());
		cleanup();

		useSettingsStore.setState({ fontZoom: 1.5 });
		clearTextMeasurementCache();
		const zoomed = tooltipWidth(renderStep());

		expect(zoomed).toBeGreaterThan(unzoomed);
	});

	it('reserves more width for a tour with more steps', () => {
		const few = tooltipWidth(renderStep({ totalSteps: 4, stepNumber: 2 }));
		cleanup();

		const many = tooltipWidth(renderStep({ totalSteps: 24, stepNumber: 2 }));
		expect(many).toBeGreaterThan(few);
	});

	it('fits the dots, the button, and the padding at every root size', () => {
		// The property that actually matters: whatever the font, the reserve
		// covers what the row will contain.
		const DOT = 0.5;
		const GAP = 0.375;
		const PAD = 1.25;
		const BUTTON_PX = 1;
		const ROW_GAP = 1;
		const totalSteps = 14;

		for (const fontSize of [12, 14, 16, 20, 24]) {
			useSettingsStore.setState({ fontSize, fontZoom: 1 });
			clearTextMeasurementCache();
			const width = tooltipWidth(renderStep({ totalSteps }));

			const dots = totalSteps * DOT + (totalSteps - 1) * GAP;
			// 'Continue' at the stub's 7px/char, plus px-4.
			const button = 'Continue'.length * 7 + BUTTON_PX * 2 * fontSize;
			const needed = (dots + PAD * 2 + ROW_GAP) * fontSize + button;

			expect(width).toBeGreaterThanOrEqual(needed);
			cleanup();
		}
	});

	it('keeps the button from shrinking into the dots', () => {
		// The structural half of the fix: even if the estimate is wrong for some
		// font, the two can no longer occupy the same pixels.
		renderStep();
		const button = screen.getByRole('button', { name: 'Continue' });

		expect(button.className).toContain('shrink-0');
		expect(button.className).toContain('whitespace-nowrap');
		// The row the button actually sits in - the header also uses
		// justify-between, so select by relationship rather than by class.
		expect(button.parentElement?.className).toContain('gap-4');
		expect(button.parentElement?.className).toContain('justify-between');
	});

	it('keeps each dot round under pressure', () => {
		// A flex item with a width but no shrink guard is squashed to an ellipse.
		const container = renderStep();
		const dots = container.querySelectorAll('.rounded-full.w-2');

		expect(dots.length).toBe(14);
		dots.forEach((dot) => expect(dot.className).toContain('shrink-0'));
	});

	it('reserves for the widest label, so the last step does not reflow', () => {
		// "Continue" becomes "Finish Tour" on the final step; the layout should
		// not jump when it does.
		const midTour = tooltipWidth(renderStep({ stepNumber: 9, isLastStep: false }));
		cleanup();
		const lastStep = tooltipWidth(renderStep({ stepNumber: 14, isLastStep: true }));

		expect(lastStep).toBe(midTour);
	});
});
