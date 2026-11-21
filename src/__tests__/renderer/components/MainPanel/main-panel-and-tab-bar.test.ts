// Source: src/__tests__/renderer/components/MainPanel/mainPanelHeaderLayout.regression.test.ts
// Source: src/__tests__/renderer/components/MainPanel/tabBarUnreadProps.regression.test.ts
// Source: src/__tests__/renderer/components/TabBar/tabBarUtils.test.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { getTabKindIcon } from '../../../../renderer/components/TabBar/tabBarUtils';
import { getTabKindColor } from '../../../../renderer/components/TabBar/tabBarUtils';
import { mockTheme } from '../../../helpers/mockTheme';
import type { TabKind } from '../../../../renderer/components/TabBar/tabBarUtils';

describe('mainPanelHeaderLayout.regression', () => {
	const COMPONENT = 'src/renderer/components/MainPanel/MainPanelHeader.tsx';
	const STYLESHEET = 'src/renderer/index.css';

	const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

	/** Every top-level (non-@container) rule body whose selector list names `className`. */
	const baseRulesFor = (rawCss: string, className: string): string[] => {
		// Comments can hold braces, which would throw the depth count off.
		const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
		const bodies: string[] = [];
		const rule = /([^{}]+)\{([^{}]*)\}/g;
		// Skip rules nested in an at-rule: track brace depth between matches.
		let depth = 0;
		let cursor = 0;
		let match: RegExpExecArray | null;
		while ((match = rule.exec(css)) !== null) {
			const between = css.slice(cursor, match.index);
			depth += (between.match(/\{/g) ?? []).length - (between.match(/\}/g) ?? []).length;
			cursor = match.index + match[0].length;
			if (depth !== 0) continue;
			if (match[1].split(',').some((s) => s.trim() === `.${className}`)) bodies.push(match[2]);
		}
		return bodies;
	};

	describe('Main Panel header layout', () => {
		it.each(['header-session-name', 'header-git-branch-text'])(
			'keeps .%s a block container so truncate can draw an ellipsis',
			(className) => {
				expect(read(COMPONENT)).toMatch(new RegExp(`${className} truncate`));
				const bodies = baseRulesFor(read(STYLESHEET), className);
				expect(bodies.length).toBeGreaterThan(0);
				for (const body of bodies) {
					expect(body).not.toMatch(/display:\s*(inline-)?flex/);
				}
			}
		);

		it('keeps a minimum gap between the header zones', () => {
			expect(read(COMPONENT)).toMatch(/header-container[^`]*justify-between gap-\d/);
		});
	});
});
describe('tabBarUnreadProps.regression', () => {
	const SOURCE = readFileSync(
		resolve(__dirname, '../../../../renderer/components/MainPanel/MainPanel.tsx'),
		'utf8'
	);

	/** Props that gate what the tab strip shows while the unread filter is active. */
	const UNREAD_FILTER_PROPS = ['showUnreadOnly', 'queuedTabIds', 'unreadGroupIds'];

	/**
	 * Slice out each `<TabBar ... />` element body. TabBar takes no children, so the
	 * first `/>` at depth zero closes it.
	 */
	function extractTabBarProps(source: string): string[] {
		const bodies: string[] = [];
		let searchFrom = 0;
		for (;;) {
			const start = source.indexOf('<TabBar', searchFrom);
			if (start === -1) break;
			const end = source.indexOf('/>', start);
			expect(end, 'every <TabBar has a self-closing />').toBeGreaterThan(start);
			bodies.push(source.slice(start, end));
			searchFrom = end + 2;
		}
		return bodies;
	}

	describe('MainPanel TabBar unread-filter props', () => {
		const tabBars = extractTabBarProps(SOURCE);

		it('renders TabBar at both the Pianola and standard sites', () => {
			expect(tabBars).toHaveLength(2);
		});

		it.each(UNREAD_FILTER_PROPS)('passes %s to every TabBar render site', (prop) => {
			const missing = tabBars.filter((body) => !body.includes(`${prop}=`)).length;
			expect(
				missing,
				`${missing} of ${tabBars.length} <TabBar> sites in MainPanel.tsx omit ${prop}. ` +
					`Its fallback is permissive, so the unread filter silently stops filtering there.`
			).toBe(0);
		});
	});
});
describe('tabBarUtils', () => {
	const ALL_KINDS: TabKind[] = ['ai', 'file', 'browser', 'terminal', 'group'];

	describe('getTabKindIcon', () => {
		it('returns an icon for every kind in the union, including group', () => {
			for (const kind of ALL_KINDS) {
				expect(getTabKindIcon(kind), `no icon for ${kind}`).toBeTruthy();
			}
		});

		it('gives each kind a distinct icon, so a mixed list is readable at a glance', () => {
			const icons = ALL_KINDS.map((kind) => getTabKindIcon(kind));
			expect(new Set(icons).size).toBe(ALL_KINDS.length);
		});
	});

	describe('getTabKindColor', () => {
		it('returns a color for every kind, group included', () => {
			for (const kind of ALL_KINDS) {
				expect(getTabKindColor(kind, mockTheme), `no color for ${kind}`).toBeTruthy();
			}
		});

		it('tracks the theme for the kinds that use semantic tokens', () => {
			expect(getTabKindColor('ai', mockTheme)).toBe(mockTheme.colors.accent);
			expect(getTabKindColor('file', mockTheme)).toBe(mockTheme.colors.warning);
			expect(getTabKindColor('terminal', mockTheme)).toBe(mockTheme.colors.success);
		});

		it('keeps browser on a fixed blue rather than a theme token', () => {
			// Deliberate: ansiBlue lands on desaturated purples/grays in several vibe
			// themes, which makes the browser icon read as gray beside the others.
			expect(getTabKindColor('browser', mockTheme)).not.toBe(mockTheme.colors.accent);
			expect(getTabKindColor('browser', mockTheme)).toMatch(/^#/);
		});
	});
});
