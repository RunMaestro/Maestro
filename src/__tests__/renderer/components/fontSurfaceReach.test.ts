import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(__dirname, '../../../..');
const read = (p: string) => readFileSync(path.join(REPO_ROOT, p), 'utf8');

/**
 * A font setting that does not reach the thing it names is worse than no
 * setting: the control promises something and silently does nothing. These
 * assert the surfaces that were previously overriding their own setting now
 * inherit or read it.
 *
 * Source assertions rather than renders: the defect is a hard-coded literal,
 * and a render test would have to construct a real file preview with real
 * parsed content to observe it.
 */
describe('font settings reach their surfaces', () => {
	describe('File Preview viewers', () => {
		const VIEWERS = [
			'src/renderer/components/JsonlViewer.tsx',
			'src/renderer/components/CsvTableRenderer.tsx',
		];

		it.each(VIEWERS)('%s pins no font family of its own', (file) => {
			// These render inside the File Preview pane, which already applies
			// the File Preview font. A hard-coded stack here overrode it, so the
			// setting silently did nothing for .jsonl and .csv files.
			expect(read(file)).not.toContain('ui-monospace, SFMono-Regular');
		});

		it.each(VIEWERS)('%s sizes everything relative to the pane', (file) => {
			const src = read(file);
			expect([...src.matchAll(/fontSize: '(\d[\d.]*px)'/g)].map((m) => m[1])).toEqual([]);
			expect(src).toMatch(/fontSize: '[\d.]+em'/);
		});

		it('keeps parquet numeric columns aligned without overriding the font', () => {
			// tabular-nums aligns digits in ANY face; the mono stack was doing
			// that job by side effect while ignoring the user's setting.
			const src = read('src/renderer/components/ParquetViewer/ParquetGrid.tsx');
			expect(src).toContain("fontVariantNumeric: 'tabular-nums'");
			expect(src).not.toContain('ui-monospace, SFMono-Regular');
		});

		it('keeps the parquet filter on a code face, but the chosen one', () => {
			// A filter expression is code, so it stays monospace - it just
			// follows the user's code font rather than a hard-coded stack.
			const src = read('src/renderer/components/ParquetViewer/ParquetFilterBar.tsx');
			expect(src).toContain('var(--maestro-font-mono');
		});
	});

	describe('Group chat', () => {
		const FILE = 'src/renderer/components/GroupChatMessages.tsx';

		it('follows the AI Chat surface', () => {
			// A group chat is an AI transcript, so it rides the same surface as
			// the main panel and the tiled panes.
			const src = read(FILE);
			expect(src).toContain("useSurfaceTypography('chat')");
		});

		it('applies both the family and the size to the transcript', () => {
			const src = read(FILE);
			expect(src).toContain('fontFamily: chatFontFamily');
			expect(src).toContain('fontSize: `${chatFontSize}px`');
		});
	});

	describe('Modal footer buttons', () => {
		it('exports the shared classes for modals that need a third button', () => {
			// Five modals hand-rolled a footer and every one invented its own
			// scale, which is how they all missed the size fix.
			const src = read('src/renderer/components/ui/Modal.tsx');
			expect(src).toContain('MODAL_BUTTON_BASE_CLASS');
			expect(src).toContain('MODAL_BUTTON_SECONDARY_CLASS');
		});

		it('sizes every hand-rolled footer button', () => {
			const HAND_ROLLED = [
				'src/renderer/components/RenameTabModal.tsx',
				'src/renderer/components/FeedbackModal.tsx',
				'src/renderer/components/ReauthModal.tsx',
				'src/renderer/components/GitCommandRunnerModal.tsx',
				'src/renderer/components/Settings/Extensions/FirstPartyEnableModal.tsx',
			];

			for (const file of HAND_ROLLED) {
				const src = read(file);
				// No padded footer-style button may lack a size class.
				const unsized = [...src.matchAll(/className="(px-[34] py-[\d.]+ rounded[^"]*)"/g)]
					.map((m) => m[1])
					.filter((cls) => !/\btext-(xs|sm|base|lg)\b/.test(cls));
				expect(unsized).toEqual([]);
			}
		});
	});
});
