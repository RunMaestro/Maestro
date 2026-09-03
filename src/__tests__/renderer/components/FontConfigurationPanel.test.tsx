import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FontConfigurationPanel } from '../../../renderer/components/FontConfigurationPanel';
import { BUNDLED_FONT_NAMES } from '../../../shared/bundledFonts';
import { DEFAULT_INTERFACE_FONT } from '../../../shared/typographyPresets';
import { FONT_PREVIEW_PROSE, withMonoFallback } from '../../../shared/fontStack';
import { mockTheme } from '../../helpers/mockTheme';

function renderPanel(overrides: Partial<React.ComponentProps<typeof FontConfigurationPanel>> = {}) {
	return render(
		<FontConfigurationPanel
			fontFamily="Roboto Mono"
			setFontFamily={vi.fn()}
			systemFonts={[]}
			fontsLoaded={false}
			fontLoading={false}
			customFonts={[]}
			onAddCustomFont={vi.fn()}
			onRemoveCustomFont={vi.fn()}
			onFontInteraction={vi.fn()}
			theme={mockTheme}
			{...overrides}
		/>
	);
}

describe('FontConfigurationPanel', () => {
	it('reports the saved font even when it is in no font group', () => {
		renderPanel({ fontFamily: 'Berkeley Mono' });

		// A <select> with no matching option silently shows its first entry, so
		// the dropdown claimed Roboto Mono while the app rendered Berkeley Mono.
		expect(screen.getByRole('combobox')).toHaveValue('Berkeley Mono');
		expect(screen.getByRole('group', { name: 'Current' })).toBeInTheDocument();
	});

	it('labels a stored font stack with its leading family, not the whole chain', () => {
		// The Default typography preset stores a full CSS stack. It matches no
		// option group, so it lands in "Current" - and the option's text is what
		// the closed select displays, which meant the user read
		// "Inter, -apple-system, BlinkMacSystemFont, ..." as the name of their
		// font. Display only: the stored value keeps its fallback chain.
		renderPanel({ fontFamily: DEFAULT_INTERFACE_FONT });

		// Scoped to the Current group: Inter also ships bundled, so the label is
		// deliberately the same string in two places and a document-wide query
		// matches both.
		const current = within(screen.getByRole('group', { name: 'Current' }));
		expect(screen.getByRole('combobox')).toHaveValue(DEFAULT_INTERFACE_FONT);
		expect(current.getByRole('option', { name: 'Inter' })).toHaveValue(DEFAULT_INTERFACE_FONT);
		expect(screen.queryByRole('option', { name: DEFAULT_INTERFACE_FONT })).not.toBeInTheDocument();
	});

	it('keeps the full stack reachable in the tooltip', () => {
		// Shortening the label must not lose the fallback chain: the tooltip is
		// how a user reads what is actually stored.
		renderPanel({ fontFamily: DEFAULT_INTERFACE_FONT });

		expect(screen.getByRole('combobox')).toHaveAttribute('title', DEFAULT_INTERFACE_FONT);
	});

	it('does not duplicate a font that is already listed', () => {
		renderPanel({ fontFamily: 'Berkeley Mono', customFonts: ['Berkeley Mono'] });

		expect(screen.getByRole('combobox')).toHaveValue('Berkeley Mono');
		expect(screen.queryByRole('group', { name: 'Current' })).not.toBeInTheDocument();
		expect(screen.getAllByRole('option', { name: 'Berkeley Mono' })).toHaveLength(1);
	});

	it('offers proportional faces alongside the monospace ones', () => {
		// Maestro was fixed width everywhere before per-surface fonts, so a
		// reading face had to be typed in by hand to be reachable at all.
		renderPanel();

		expect(screen.getByRole('group', { name: 'Common Proportional Fonts' })).toBeInTheDocument();
		for (const font of ['Arial', 'Helvetica', 'Verdana', 'Avenir Next']) {
			expect(screen.getByRole('option', { name: font })).toBeInTheDocument();
		}
	});

	it('leaves the inherit option selectable without a Current group', () => {
		renderPanel({
			fontFamily: '',
			inheritOptions: [{ value: '', label: 'Same as interface font' }],
		});

		expect(screen.getByRole('combobox')).toHaveValue('');
		expect(screen.queryByRole('group', { name: 'Current' })).not.toBeInTheDocument();
	});

	it('renders a removable pill for each custom font', () => {
		const onRemoveCustomFont = vi.fn();
		renderPanel({ customFonts: ['Verdana', 'Helvetica'], onRemoveCustomFont });

		const removeButtons = screen.getAllByRole('button', { name: '\u00d7' });
		expect(removeButtons).toHaveLength(2);

		fireEvent.click(removeButtons[0]);
		expect(onRemoveCustomFont).toHaveBeenCalledWith('Verdana');
	});
	describe('arrow-key preview', () => {
		it('steps to the next and previous font without opening the dropdown', () => {
			// Ordering follows the rendered groups, which now lead with the
			// bundled fonts: JetBrains Mono -> Fira Code -> Roboto Mono ...
			const setFontFamily = vi.fn();
			renderPanel({ fontFamily: 'Fira Code', setFontFamily });
			const select = screen.getByRole('combobox');

			fireEvent.keyDown(select, { key: 'ArrowDown' });
			expect(setFontFamily).toHaveBeenLastCalledWith('Roboto Mono');

			fireEvent.keyDown(select, { key: 'ArrowUp' });
			expect(setFontFamily).toHaveBeenLastCalledWith('JetBrains Mono');
		});

		it('walks out of one group and into the next', () => {
			const setFontFamily = vi.fn();
			renderPanel({
				// Last bundled font; the next group is Common Monospace.
				fontFamily: BUNDLED_FONT_NAMES[BUNDLED_FONT_NAMES.length - 1],
				setFontFamily,
			});

			fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
			// The first system monospace face that is not also bundled.
			expect(setFontFamily).toHaveBeenCalledWith('Monaco');
		});

		it('reaches the installed fonts once the system sweep has run', () => {
			const setFontFamily = vi.fn();
			renderPanel({
				fontFamily: 'Iosevka',
				setFontFamily,
				customFonts: ['Iosevka'],
				systemFonts: ['Zapfino'],
				fontsLoaded: true,
			});

			fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
			expect(setFontFamily).toHaveBeenCalledWith('Zapfino');
		});

		it('stops at the ends instead of wrapping', () => {
			const setFontFamily = vi.fn();
			// The first entry overall is now the first bundled font.
			const { rerender } = renderPanel({ fontFamily: BUNDLED_FONT_NAMES[0], setFontFamily });

			fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowUp' });
			expect(setFontFamily).not.toHaveBeenCalled();

			rerender(
				<FontConfigurationPanel
					fontFamily="Georgia"
					setFontFamily={setFontFamily}
					systemFonts={[]}
					fontsLoaded={false}
					fontLoading={false}
					customFonts={[]}
					onAddCustomFont={vi.fn()}
					onRemoveCustomFont={vi.fn()}
					onFontInteraction={vi.fn()}
					theme={mockTheme}
				/>
			);
			fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
			expect(setFontFamily).not.toHaveBeenCalled();
		});

		it('starts from the inherit entry when the terminal font inherits', () => {
			const setFontFamily = vi.fn();
			renderPanel({
				fontFamily: '',
				setFontFamily,
				inheritOptions: [{ value: '', label: 'Same as interface font' }],
			});

			fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
			expect(setFontFamily).toHaveBeenCalledWith(BUNDLED_FONT_NAMES[0]);
		});

		it('leaves other keys to the browser', () => {
			const setFontFamily = vi.fn();
			renderPanel({ fontFamily: 'Roboto Mono', setFontFamily });

			fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
			fireEvent.keyDown(screen.getByRole('combobox'), { key: 'a' });
			expect(setFontFamily).not.toHaveBeenCalled();
		});
	});
	describe('bundled fonts', () => {
		it('lists the fonts that ship with the app', () => {
			renderPanel();
			expect(screen.getByRole('group', { name: /Bundled with Maestro/ })).toBeInTheDocument();
		});

		it('never marks a bundled font missing, even when detection found nothing', () => {
			// A bundled font's presence is a fact, not a guess - it is inside the
			// app bundle. Annotating one "(Not Found)" would be false.
			renderPanel({ systemFonts: [], fontsLoaded: true, fontsReliable: true });

			// Read the group directly rather than by option name: several bundled
			// families share a prefix ("Roboto" / "Roboto Mono"), so a name regex
			// matches more than one.
			const group = screen.getByRole('group', { name: /Bundled with Maestro/ });
			const options = [...group.querySelectorAll('option')];
			expect(options).toHaveLength(BUNDLED_FONT_NAMES.length);
			for (const option of options) {
				expect(option.textContent).not.toContain('(Not Found)');
			}
		});

		it('names the proprietary face a substitute matches', () => {
			renderPanel();
			expect(screen.getByRole('option', { name: /Arimo - like Arial/ })).toBeInTheDocument();
		});
	});

	describe('unreliable detection', () => {
		it('suppresses availability annotations when the font list is a guess', () => {
			// This is the bug that made Arial read "(Not Found)" on a stock Mac:
			// fc-list is absent there, detection fell back to a seven-font list,
			// and every real font was then declared missing.
			renderPanel({
				systemFonts: ['Monaco', 'Menlo'],
				fontsLoaded: true,
				fontsReliable: false,
			});

			expect(screen.queryByText(/\(Not Found\)/)).not.toBeInTheDocument();
			expect(screen.getByText(/Installed fonts couldn't be listed/)).toBeInTheDocument();
		});

		it('still annotates when detection actually enumerated the machine', () => {
			renderPanel({
				systemFonts: ['Monaco', 'Menlo'],
				fontsLoaded: true,
				fontsReliable: true,
			});

			expect(screen.getAllByText(/\(Not Found\)/).length).toBeGreaterThan(0);
		});
	});

	it('renders a size control beside the picker when given one', () => {
		renderPanel({ sizeControl: <span data-testid="size-slot">size</span> });
		expect(screen.getByTestId('size-slot')).toBeInTheDocument();
	});

	describe('font previews', () => {
		it('draws every option naming a face in that face', () => {
			// The list IS the preview: reading the difference between two
			// candidates should not require selecting either one.
			renderPanel({ customFonts: ['Iosevka'], systemFonts: ['Zapfino'] });

			// One from each group that names a real face: bundled, common
			// monospace, common proportional, custom, and installed.
			for (const font of ['Inter', 'Monaco', 'Georgia', 'Iosevka', 'Zapfino']) {
				expect(screen.getByRole('option', { name: font })).toHaveStyle({ fontFamily: font });
			}
		});

		it('draws the Current option in the stored stack rather than the shortened label', () => {
			renderPanel({ fontFamily: DEFAULT_INTERFACE_FONT });

			const current = within(screen.getByRole('group', { name: 'Current' }));
			expect(current.getByRole('option', { name: 'Inter' })).toHaveStyle({
				fontFamily: DEFAULT_INTERFACE_FONT,
			});
		});

		it('leaves the inherit entries unstyled, since they name a relationship', () => {
			renderPanel({
				fontFamily: '',
				inheritOptions: [{ value: '', label: 'Same as interface font' }],
			});

			expect(screen.getByRole('option', { name: 'Same as interface font' }).style.fontFamily).toBe(
				''
			);
		});

		it('shows a live sample in the resolved face and size it was given', () => {
			// The caller passes the surface's resolved values because the selected
			// value alone can be an inherit sentinel, which is no face at all.
			renderPanel({
				fontFamily: '',
				inheritOptions: [{ value: '', label: 'Same as interface font' }],
				previewFontFamily: 'var(--maestro-font-chat)',
				previewFontSize: 'var(--maestro-size-chat)',
			});

			const sample = within(screen.getByTestId('font-preview')).getByText(FONT_PREVIEW_PROSE);
			expect(sample.style.fontFamily).toBe('var(--maestro-font-chat)');
			expect(sample.style.fontSize).toBe('var(--maestro-size-chat)');
		});

		it('falls back to the selected font with a safe fallback chain', () => {
			// Without a resolved value the selected family is already a face, but a
			// bare name that is not installed drops the sample to the browser's
			// serif default, which reads as the font being broken.
			renderPanel({ fontFamily: 'Berkeley Mono' });

			const sample = within(screen.getByTestId('font-preview')).getByText(FONT_PREVIEW_PROSE);
			expect(sample).toHaveStyle({ fontFamily: withMonoFallback('Berkeley Mono') });
		});

		it('keeps the sample to a single line', () => {
			// Compact pickers sit in a six-cell grid; a sample that wrapped would
			// add a row of height per surface and move it around as the pane
			// resizes.
			renderPanel({ compact: true });

			const sample = within(screen.getByTestId('font-preview')).getByText(FONT_PREVIEW_PROSE);
			expect(sample).toHaveClass('truncate');
		});
	});
});
