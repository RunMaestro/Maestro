/**
 * Settings style-guide enforcement.
 *
 * These are source-scanning tests, not render tests: they parse the JSX of every
 * file under `src/renderer/components/Settings/` and fail on the style defects
 * that keep getting reintroduced by copy-paste. See CLAUDE-SETTINGS.md for the
 * rationale and the measured contrast data behind rule 1.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { THEMES } from '../../../../shared/themes';
import { AA_LARGE_CONTRAST, contrastRatio, transparentize } from '../../../../shared/colorContrast';

const SETTINGS_ROOT = resolve(__dirname, '../../../../renderer/components/Settings');
const RENDERER_COMPONENTS = resolve(__dirname, '../../../../renderer/components');

/**
 * Tabs that have been migrated to `SettingsSectionHeading`, so a hand-rolled
 * heading appearing in one is a regression rather than known debt.
 *
 * Widen this as each remaining tab is migrated - the guard is per-tab on
 * purpose, because a tree-wide rule would fail on the tabs CLAUDE-SETTINGS.md
 * still lists as outstanding and would then simply be disabled.
 */
const MIGRATED_HEADING_SCOPES = [
	join(SETTINGS_ROOT, 'tabs/GeneralTab'),
	join(SETTINGS_ROOT, 'tabs/ThemeTab.tsx'),
	join(SETTINGS_ROOT, 'tabs/ShortcutsTab.tsx'),
];

/** Every tab root owns the vertical rhythm between its sections, and it is `space-y-5`. */
const TAB_ROOT_RHYTHM = 'space-y-5';

/**
 * Files that render INTO the Settings tree but live outside it, so the dim-scale
 * rule has to reach them explicitly. Both are font controls the Display tab
 * mounts, and both are where the off-scale `opacity-60` came from.
 */
const SETTINGS_ADJACENT = [
	join(RENDERER_COMPONENTS, 'FontConfigurationPanel.tsx'),
	join(RENDERER_COMPONENTS, 'ui/FontSizeStepper.tsx'),
];

function walkTsx(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walkTsx(full, out);
		else if (full.endsWith('.tsx')) out.push(full);
	}
	return out;
}

/** Accepts either a directory to walk or a single `.tsx` path. */
function tsxFilesIn(target: string): string[] {
	return statSync(target).isDirectory() ? walkTsx(target) : [target];
}

interface JsxTag {
	tag: string;
	body: string;
	line: number;
}

/**
 * Extract every JSX opening tag with its full attribute list. Tags routinely span
 * several lines after Prettier, so a line-based regex produces false positives on
 * neighbouring elements; this walks to the matching `>` while tracking brace depth
 * and string literals instead.
 */
function parseJsxTags(src: string): JsxTag[] {
	const tags: JsxTag[] = [];
	const opener = /<([A-Za-z][\w.]*)/g;
	let match: RegExpExecArray | null;

	while ((match = opener.exec(src))) {
		let i = opener.lastIndex;
		let depth = 0;
		let quote: string | null = null;

		for (; i < src.length; i++) {
			const char = src[i];
			if (quote) {
				if (char === quote) quote = null;
				continue;
			}
			if (char === '"' || char === "'" || char === '`') {
				quote = char;
				continue;
			}
			if (char === '{') depth++;
			else if (char === '}') depth--;
			else if (char === '>' && depth === 0) break;
		}

		tags.push({
			tag: match[1],
			body: src.slice(match.index, i + 1),
			line: src.slice(0, match.index).split('\n').length,
		});
	}
	return tags;
}

function classNameOf(body: string): string | null {
	const match = body.match(/className=(?:"([^"]*)"|\{`([^`]*)`\})/);
	if (!match) return null;
	return match[1] ?? match[2] ?? '';
}

/** A decorative Lucide icon sized by utility classes, carrying no text of its own. */
function isDecorativeIcon(tag: string, className: string): boolean {
	return /^[A-Z]/.test(tag) && /w-\d|h-\d/.test(className) && !/text-/.test(className);
}

describe('Settings style guide', () => {
	describe('no double-dimming (CLAUDE-SETTINGS.md rule 1)', () => {
		it('never combines an opacity utility with theme.colors.textDim on the same element', () => {
			const offenders: string[] = [];

			for (const file of walkTsx(SETTINGS_ROOT)) {
				const src = readFileSync(file, 'utf8');
				for (const { tag, body, line } of parseJsxTags(src)) {
					const className = classNameOf(body);
					if (className === null) continue;

					// Only unconditional opacity counts. `disabled:opacity-40` and
					// `hover:opacity-80` are state variants, not a resting-state dim.
					if (!/(?:^|\s)opacity-\d+/.test(className)) continue;
					if (isDecorativeIcon(tag, className)) continue;
					if (!/color:\s*theme\.colors\.textDim/.test(body)) continue;

					offenders.push(`  ${file.replace(SETTINGS_ROOT, 'Settings')}:${line} <${tag}>`);
				}
			}

			expect(
				offenders,
				'Double-dimmed text found: these elements stack an opacity-* utility on top of ' +
					'theme.colors.textDim, which multiplies the two dimming channels and drops contrast ' +
					'below the 3:1 floor in 17 of 21 themes.\n' +
					'Fix: delete the `color: theme.colors.textDim` override and keep the opacity utility ' +
					'(descriptions inherit textMain by design).\n' +
					offenders.join('\n')
			).toEqual([]);
		});
	});

	describe('shared primitives (CLAUDE-SETTINGS.md rule 3)', () => {
		it('migrated tabs use SettingsSectionHeading instead of hand-rolled headings', () => {
			const offenders: string[] = [];

			for (const scope of MIGRATED_HEADING_SCOPES) {
				for (const file of tsxFilesIn(scope)) {
					const src = readFileSync(file, 'utf8');
					src.split('\n').forEach((text, index) => {
						const className = text.match(/className="([^"]*)"/)?.[1];
						if (!className) return;
						// The section-heading signature. Small uppercase pills/badges are a
						// different thing and are identified by their padding + tiny type.
						if (!/font-bold/.test(className) || !/uppercase/.test(className)) return;
						if (/px-\d|text-\[[89]px\]/.test(className)) return;

						offenders.push(`  ${file.replace(SETTINGS_ROOT, 'Settings')}:${index + 1}`);
					});
				}
			}

			expect(
				offenders,
				'Hand-rolled section headings found in a migrated tab. Use ' +
					'<SettingsSectionHeading icon={Icon}>Label</SettingsSectionHeading> so every heading ' +
					'shares one spelling:\n' +
					offenders.join('\n')
			).toEqual([]);
		});

		// `SettingsSectionHeading` owns the gap between a heading and its intro
		// paragraph, via the `description` prop. Before it did, four sections
		// hand-rolled that paragraph and each pulled it back up with a negative
		// margin cancelling the heading's own `mb-2` - which is the same distance
		// written twice, in opposite directions, in two different files.
		it('never claws back a heading margin with a negative top margin', () => {
			const offenders: string[] = [];

			for (const file of walkTsx(SETTINGS_ROOT)) {
				const src = readFileSync(file, 'utf8');
				for (const { tag, body, line } of parseJsxTags(src)) {
					const className = classNameOf(body);
					if (className === null) continue;
					if (!/(?:^|\s)-mt-\d/.test(className)) continue;

					offenders.push(`  ${file.replace(SETTINGS_ROOT, 'Settings')}:${line} <${tag}>`);
				}
			}

			expect(
				offenders,
				'Negative top margin found in the Settings tree. A heading followed by an intro ' +
					'paragraph passes that copy as <SettingsSectionHeading description={...}>, which ' +
					'states the gap once instead of setting it and then subtracting it:\n' +
					offenders.join('\n')
			).toEqual([]);
		});
	});

	describe('one vertical rhythm per tab (CLAUDE-SETTINGS.md rule 6)', () => {
		// Sections carry no margins of their own, so the tab root is the only
		// place the gap between them is decided. Three tabs had drifted to their
		// own value, which reads as three different densities inside one modal.
		const TAB_ROOTS: Array<[string, string]> = [
			['DisplayTab', 'tabs/DisplayTab/DisplayTab.tsx'],
			['GeneralTab', 'tabs/GeneralTab/GeneralTab.tsx'],
			['ThemeTab', 'tabs/ThemeTab.tsx'],
			['ShortcutsTab', 'tabs/ShortcutsTab.tsx'],
			['EncoreTab', 'tabs/EncoreTab/EncoreTab.tsx'],
			['EnvironmentTab', 'tabs/EnvironmentTab.tsx'],
		];

		it.each(TAB_ROOTS)('%s spaces its sections with space-y-5', (_name, relative) => {
			const src = readFileSync(join(SETTINGS_ROOT, relative), 'utf8');
			const rhythms = [...src.matchAll(/space-y-(\d+)/g)]
				.map((match) => Number(match[1]))
				// Rows inside a card are a tighter scale and are not the tab rhythm.
				.filter((value) => value > 3);

			expect(
				[...new Set(rhythms)],
				`Section rhythm must be ${TAB_ROOT_RHYTHM}. Anything looser or tighter makes one tab ` +
					'read at a different density from the rest of the modal.'
			).toEqual([5]);
		});
	});

	describe('two dim levels only (CLAUDE-SETTINGS.md rule 4)', () => {
		// The scale is `opacity-70` for descriptions and `opacity-55` for
		// micro-notes. `opacity-60` is the value the tree keeps drifting back to,
		// because it is what a new section gets when someone eyeballs a dim
		// instead of reading the guide - and at 60 the contrast measurement in
		// the block below no longer holds. Banning the one wrong value keeps the
		// guard specific enough to name the fix.
		it('never uses opacity-60 on text', () => {
			const offenders: string[] = [];

			for (const file of [...walkTsx(SETTINGS_ROOT), ...SETTINGS_ADJACENT]) {
				const src = readFileSync(file, 'utf8');
				for (const { tag, body, line } of parseJsxTags(src)) {
					const className = classNameOf(body);
					if (className === null) continue;
					if (!/(?:^|\s)opacity-60(?:\s|$)/.test(className)) continue;
					// A dimmed icon is deliberate de-emphasis of a glyph, not text
					// on the description scale.
					if (isDecorativeIcon(tag, className)) continue;

					offenders.push(`  ${file.replace(RENDERER_COMPONENTS, 'components')}:${line} <${tag}>`);
				}
			}

			expect(
				offenders,
				'Off-scale dim found. Settings text has exactly two dim levels: `opacity-70` for a ' +
					'description (`text-xs`) and `opacity-55` for a micro-note (`text-[11px]`). Pick the ' +
					'one that matches the role of the line:\n' +
					offenders.join('\n')
			).toEqual([]);
		});
	});

	describe('description text stays legible in every theme (CLAUDE-SETTINGS.md rule 4)', () => {
		// `opacity-70` on inherited textMain is the description standard. An opacity
		// utility blends the text toward whatever sits behind it, so a theme whose
		// textMain is too close to its background drops secondary copy under the
		// WCAG 3:1 floor - and no per-element lint can see that. This is what forced
		// solarized-light's textMain up to base02; guard it here so a future theme
		// edit in src/shared/themes.ts cannot quietly undo it.
		const DESCRIPTION_ALPHA = 0.7;

		it.each(['bgMain', 'bgSidebar'] as const)(
			'textMain at 70%% clears 3:1 over %s in all themes',
			(bgKey) => {
				const offenders = Object.entries(THEMES)
					.map(([id, theme]) => {
						const bg = theme.colors[bgKey];
						const ratio = contrastRatio(
							transparentize(theme.colors.textMain, bg, DESCRIPTION_ALPHA),
							bg
						);
						return { id, ratio };
					})
					.filter(({ ratio }) => ratio < AA_LARGE_CONTRAST)
					.map(({ id, ratio }) => `  ${id}: ${ratio.toFixed(2)}:1`);

				expect(
					offenders,
					`Dimmed description text falls below ${AA_LARGE_CONTRAST}:1 over ${bgKey}. ` +
						"Raise that theme's textMain contrast in src/shared/themes.ts - do NOT lower the " +
						'description opacity, which would desynchronise the tree from CLAUDE-SETTINGS.md.\n' +
						offenders.join('\n')
				).toEqual([]);
			}
		);
	});
});
