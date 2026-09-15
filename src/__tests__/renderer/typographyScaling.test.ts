import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(__dirname, '../../..');

/**
 * Files this backport owns. rc's scan covers the whole renderer plus the web
 * client because those trees were already converted to rem. This branch still
 * has the legacy `src/web` PWA and many chrome files with frozen px sizes;
 * converting those is a later sweep, not this typography port.
 */
const SCALED_ROOTS = [
	'src/renderer/App.tsx',
	'src/renderer/utils/applyTypographyVars.ts',
	'src/renderer/components/OnboardingSeriesHost.tsx',
	'src/renderer/components/TypographyChoiceModal.tsx',
	'src/renderer/components/ThemeChoiceModal.tsx',
	'src/renderer/components/UpdatesChoiceModal.tsx',
	'src/renderer/components/AgentPowersModal.tsx',
	'src/renderer/components/ui/ModalBackButton.tsx',
	'src/renderer/components/Settings/tabs/DisplayTypography',
];

function tsxFiles(): string[] {
	const files: string[] = [];
	for (const root of SCALED_ROOTS) {
		const abs = path.join(REPO_ROOT, root);
		if (!existsSync(abs)) continue;
		if (statSync(abs).isDirectory()) {
			for (const file of readdirSync(abs, { recursive: true, encoding: 'utf8' })) {
				if (file.endsWith('.tsx') || file.endsWith('.ts')) {
					files.push(path.join(root, file));
				}
			}
		} else {
			files.push(root);
		}
	}
	return files;
}

/**
 * Everything the user can see must resize when they zoom the interface.
 *
 * A `fontSize` given in px is frozen: it ignores both the interface font size
 * and the Cmd+= multiplier, so it grows out of proportion with its neighbours
 * as the app scales around it. `rem` follows the root, `em` follows the
 * parent, and both track the zoom.
 *
 * This is a source scan rather than a render assertion because the defect is
 * a literal in a style object - a rendered test would have to visit every
 * component to find one, and would still miss the ones behind a conditional.
 */
describe('font sizes scale with the interface', () => {
	it('declares no fontSize in px on the surfaces this port wired', () => {
		const offenders: string[] = [];

		for (const file of tsxFiles()) {
			const src = readFileSync(path.join(REPO_ROOT, file), 'utf8');
			for (const match of src.matchAll(/fontSize:\s*['"`](\d[\d.]*px)['"`]/g)) {
				offenders.push(`${file} -> ${match[1]}`);
			}
		}

		expect(offenders).toEqual([]);
	});

	it('allows px in a computed value, which is derived from the scaled size', () => {
		// `${resolveSurfaceFontSize(...)}px` is fine: the NUMBER already has the
		// zoom applied. Only a hard-coded literal is frozen. This asserts the
		// rule above is not accidentally banning the correct pattern.
		const src = readFileSync(
			path.join(REPO_ROOT, 'src/renderer/utils/applyTypographyVars.ts'),
			'utf8'
		);
		expect(src).toContain('px`');
	});
});
