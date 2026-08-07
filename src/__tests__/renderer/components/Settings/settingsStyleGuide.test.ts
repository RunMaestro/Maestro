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
const GENERAL_TAB = join(SETTINGS_ROOT, 'tabs/GeneralTab');

function walkTsx(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walkTsx(full, out);
		else if (full.endsWith('.tsx')) out.push(full);
	}
	return out;
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
		it('GeneralTab uses SettingsSectionHeading instead of hand-rolled headings', () => {
			const offenders: string[] = [];

			for (const file of walkTsx(GENERAL_TAB)) {
				const src = readFileSync(file, 'utf8');
				src.split('\n').forEach((text, index) => {
					const className = text.match(/className="([^"]*)"/)?.[1];
					if (!className) return;
					// The section-heading signature. Small uppercase pills/badges are a
					// different thing and are identified by their padding + tiny type.
					if (!/font-bold/.test(className) || !/uppercase/.test(className)) return;
					if (/px-\d|text-\[[89]px\]/.test(className)) return;

					offenders.push(`  ${file.replace(GENERAL_TAB, 'GeneralTab')}:${index + 1}`);
				});
			}

			expect(
				offenders,
				'Hand-rolled section headings found in GeneralTab. Use ' +
					'<SettingsSectionHeading icon={Icon}>Label</SettingsSectionHeading> so every heading ' +
					'shares one spelling:\n' +
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
