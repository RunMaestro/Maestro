/**
 * Tests for NarrativeParseError - the OVERT failure surface for Rich Mode.
 *
 * Verifies it:
 * - renders a loud, unmissable banner (role="alert" + heading + the precise error)
 * - keeps the raw agent output hidden behind a "View raw output" disclosure that
 *   toggles (and tracks aria-expanded)
 * - copies the raw output verbatim and confirms with "Copied!"
 * - never copies when there is no raw output to copy
 *
 * safeClipboardWrite falls back to `navigator.clipboard.writeText` when the
 * Electron shell bridge is absent, so the clipboard is mocked there.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NarrativeParseError } from '../../../../renderer/components/DirectorNotes/NarrativeParseError';
import { mockTheme } from '../../../helpers/mockTheme';

const ERROR = 'sections[0].items[1].text must be a string.';
const RAW = '{"version":1,"sections":[{"kind":"accomplishments","title":"x","items":[{}]}]}';

const mockWriteText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
	// No Electron shell bridge in tests, so safeClipboardWrite uses navigator.
	(window as unknown as { maestro?: unknown }).maestro = undefined;
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		writable: true,
		value: { writeText: mockWriteText },
	});
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('NarrativeParseError', () => {
	it('renders a loud alert banner with the heading and the precise error', () => {
		render(<NarrativeParseError theme={mockTheme} error={ERROR} rawOutput={RAW} />);

		const banner = screen.getByRole('alert');
		expect(banner).toBeInTheDocument();
		expect(
			screen.getByText("Rich Mode could not parse the AI's structured output")
		).toBeInTheDocument();
		expect(screen.getByText(ERROR)).toBeInTheDocument();
	});

	it('hides the raw output until the disclosure is opened', () => {
		render(<NarrativeParseError theme={mockTheme} error={ERROR} rawOutput={RAW} />);

		expect(screen.queryByText(RAW)).not.toBeInTheDocument();

		const toggle = screen.getByRole('button', { name: /view raw output/i });
		expect(toggle).toHaveAttribute('aria-expanded', 'false');
	});

	it('reveals the raw output and flips the disclosure label/state on click', () => {
		render(<NarrativeParseError theme={mockTheme} error={ERROR} rawOutput={RAW} />);

		fireEvent.click(screen.getByRole('button', { name: /view raw output/i }));

		expect(screen.getByText(RAW)).toBeInTheDocument();
		const toggle = screen.getByRole('button', { name: /hide raw output/i });
		expect(toggle).toHaveAttribute('aria-expanded', 'true');
	});

	it('hides the raw output again on a second click', () => {
		render(<NarrativeParseError theme={mockTheme} error={ERROR} rawOutput={RAW} />);

		fireEvent.click(screen.getByRole('button', { name: /view raw output/i }));
		expect(screen.getByText(RAW)).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /hide raw output/i }));
		expect(screen.queryByText(RAW)).not.toBeInTheDocument();
	});

	it('copies the raw output verbatim and confirms with "Copied!"', async () => {
		render(<NarrativeParseError theme={mockTheme} error={ERROR} rawOutput={RAW} />);

		fireEvent.click(screen.getByRole('button', { name: /view raw output/i }));
		fireEvent.click(screen.getByRole('button', { name: /^copy$/i }));

		await waitFor(() => {
			expect(mockWriteText).toHaveBeenCalledWith(RAW);
		});
		expect(await screen.findByText('Copied!')).toBeInTheDocument();
	});

	it('does not attempt a copy when there is no raw output', () => {
		render(<NarrativeParseError theme={mockTheme} error={ERROR} rawOutput="" />);

		fireEvent.click(screen.getByRole('button', { name: /view raw output/i }));
		fireEvent.click(screen.getByRole('button', { name: /^copy$/i }));

		expect(mockWriteText).not.toHaveBeenCalled();
	});
});
