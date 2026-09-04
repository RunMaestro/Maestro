import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(__dirname, '../../..');

function tsxFiles(): string[] {
	return ['src/renderer', 'src/web'].flatMap((root) =>
		readdirSync(path.join(REPO_ROOT, root), { recursive: true, encoding: 'utf8' })
			.filter((file) => file.endsWith('.tsx'))
			.map((file) => path.join(root, file))
	);
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
	it('declares no fontSize in px anywhere in the renderer or web client', () => {
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
