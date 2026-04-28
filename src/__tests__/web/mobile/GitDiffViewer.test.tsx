/**
 * Tests for GitDiffViewer component — focused on the Unified/Split view-mode
 * toggle added in Phase 3 Task 3.7: default-by-tier, persistence to
 * localStorage, and the basic structure of each renderer.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import {
	GitDiffViewer,
	DIFF_VIEW_MODE_STORAGE_KEY,
	loadDiffViewMode,
} from '../../../web/mobile/GitDiffViewer';

// Mock useThemeColors — matches the shape used by the component.
const mockColors = {
	bgMain: '#1a1a1a',
	bgSidebar: '#111111',
	textMain: '#ffffff',
	textDim: '#888888',
	border: '#333333',
	accent: '#007acc',
	accentForeground: '#ffffff',
	warning: '#f5a623',
	error: '#f44336',
	success: '#4caf50',
};

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
}));

// Breakpoint mock — controlled per test via `setBreakpointState`.
let breakpointState = { isPhone: false };
function setBreakpointState(next: { isPhone: boolean }) {
	breakpointState = next;
}
vi.mock('../../../web/hooks/useBreakpoint', () => ({
	useBreakpoint: () => breakpointState,
}));

// Stub haptics so jsdom doesn't need to implement navigator.vibrate.
vi.mock('../../../web/mobile/constants', async () => {
	const actual = await vi.importActual<Record<string, unknown>>('../../../web/mobile/constants');
	return {
		...actual,
		triggerHaptic: () => {},
	};
});

// The project-wide test setup sometimes replaces window.localStorage with
// partial mocks from other test files. Install our own fully-functional
// backing store so this file is self-contained.
let localStorageStore: Record<string, string> = {};
const localStorageMock: Storage = {
	getItem: (key: string) => localStorageStore[key] ?? null,
	setItem: (key: string, value: string) => {
		localStorageStore[key] = String(value);
	},
	removeItem: (key: string) => {
		delete localStorageStore[key];
	},
	clear: () => {
		localStorageStore = {};
	},
	key: (index: number) => Object.keys(localStorageStore)[index] ?? null,
	get length() {
		return Object.keys(localStorageStore).length;
	},
};
Object.defineProperty(window, 'localStorage', {
	value: localStorageMock,
	writable: true,
	configurable: true,
});

// A compact but representative unified diff with a hunk that includes both
// a pure-remove pair, a 1:1 remove/add pair, and a trailing add.
const SAMPLE_DIFF = `diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -1,4 +1,5 @@
 context-1
-old-line-1
-old-line-2
+new-line-1
+new-line-2
+new-line-3
 context-2
`;

describe('GitDiffViewer', () => {
	beforeEach(() => {
		localStorageStore = {};
		setBreakpointState({ isPhone: false });
	});

	afterEach(() => {
		cleanup();
	});

	describe('View mode toggle', () => {
		it('renders both Unified and Split buttons in a tablist', () => {
			render(<GitDiffViewer diff={SAMPLE_DIFF} filePath="file.txt" onBack={() => {}} />);

			const tablist = screen.getByRole('tablist', { name: /diff view mode/i });
			expect(tablist).toBeInTheDocument();

			const tabs = screen.getAllByRole('tab');
			expect(tabs).toHaveLength(2);
			expect(tabs[0]).toHaveTextContent(/unified/i);
			expect(tabs[1]).toHaveTextContent(/split/i);
		});

		it('switches mode when a tab is clicked and marks the new tab selected', () => {
			setBreakpointState({ isPhone: true });
			render(<GitDiffViewer diff={SAMPLE_DIFF} filePath="file.txt" onBack={() => {}} />);

			const unifiedTab = screen.getByRole('tab', { name: /unified/i });
			const splitTab = screen.getByRole('tab', { name: /split/i });

			expect(unifiedTab).toHaveAttribute('aria-selected', 'true');
			expect(splitTab).toHaveAttribute('aria-selected', 'false');

			fireEvent.click(splitTab);

			expect(unifiedTab).toHaveAttribute('aria-selected', 'false');
			expect(splitTab).toHaveAttribute('aria-selected', 'true');
		});
	});

	describe('Default by viewport tier', () => {
		it('defaults to unified on phone', () => {
			setBreakpointState({ isPhone: true });
			render(<GitDiffViewer diff={SAMPLE_DIFF} filePath="file.txt" onBack={() => {}} />);

			expect(screen.getByRole('tab', { name: /unified/i })).toHaveAttribute(
				'aria-selected',
				'true'
			);
			expect(document.querySelector('[data-diff-view="unified"]')).not.toBeNull();
			expect(document.querySelector('[data-diff-view="split"]')).toBeNull();
		});

		it('defaults to split on tablet and above', () => {
			setBreakpointState({ isPhone: false });
			render(<GitDiffViewer diff={SAMPLE_DIFF} filePath="file.txt" onBack={() => {}} />);

			expect(screen.getByRole('tab', { name: /split/i })).toHaveAttribute('aria-selected', 'true');
			expect(document.querySelector('[data-diff-view="split"]')).not.toBeNull();
			expect(document.querySelector('[data-diff-view="unified"]')).toBeNull();
		});
	});

	describe('Persistence', () => {
		it('writes the chosen mode to localStorage under the documented key', () => {
			setBreakpointState({ isPhone: false });
			render(<GitDiffViewer diff={SAMPLE_DIFF} filePath="file.txt" onBack={() => {}} />);

			fireEvent.click(screen.getByRole('tab', { name: /unified/i }));

			expect(localStorage.getItem(DIFF_VIEW_MODE_STORAGE_KEY)).toBe('unified');
		});

		it('prefers the stored preference over the tier-based default', () => {
			// Stored = split, but viewport reports phone (which would default to unified).
			localStorage.setItem(DIFF_VIEW_MODE_STORAGE_KEY, 'split');
			setBreakpointState({ isPhone: true });

			render(<GitDiffViewer diff={SAMPLE_DIFF} filePath="file.txt" onBack={() => {}} />);

			expect(screen.getByRole('tab', { name: /split/i })).toHaveAttribute('aria-selected', 'true');
			expect(document.querySelector('[data-diff-view="split"]')).not.toBeNull();
		});

		it('ignores garbage values in localStorage and falls back to the tier default', () => {
			localStorage.setItem(DIFF_VIEW_MODE_STORAGE_KEY, 'bogus-value');
			setBreakpointState({ isPhone: true });

			render(<GitDiffViewer diff={SAMPLE_DIFF} filePath="file.txt" onBack={() => {}} />);

			expect(screen.getByRole('tab', { name: /unified/i })).toHaveAttribute(
				'aria-selected',
				'true'
			);
		});
	});

	describe('loadDiffViewMode', () => {
		it('returns null when nothing is stored', () => {
			expect(loadDiffViewMode()).toBeNull();
		});

		it('returns the stored mode when valid', () => {
			localStorage.setItem(DIFF_VIEW_MODE_STORAGE_KEY, 'split');
			expect(loadDiffViewMode()).toBe('split');

			localStorage.setItem(DIFF_VIEW_MODE_STORAGE_KEY, 'unified');
			expect(loadDiffViewMode()).toBe('unified');
		});

		it('returns null for invalid stored values', () => {
			localStorage.setItem(DIFF_VIEW_MODE_STORAGE_KEY, 'hybrid');
			expect(loadDiffViewMode()).toBeNull();
		});
	});

	describe('Empty diff', () => {
		it('shows the empty-state message and no renderer in either mode', () => {
			setBreakpointState({ isPhone: false });
			render(<GitDiffViewer diff="   " filePath="file.txt" onBack={() => {}} />);

			expect(screen.getByText(/no diff available/i)).toBeInTheDocument();
			expect(document.querySelector('[data-diff-view]')).toBeNull();
		});
	});

	describe('Split renderer content', () => {
		it('pairs remove/add lines and leaves trailing adds with an empty left cell', () => {
			setBreakpointState({ isPhone: false });
			const { container } = render(
				<GitDiffViewer diff={SAMPLE_DIFF} filePath="file.txt" onBack={() => {}} />
			);

			const splitPre = container.querySelector('[data-diff-view="split"]');
			expect(splitPre).not.toBeNull();
			const text = splitPre?.textContent ?? '';

			// Both sides of a pair appear in the rendered output.
			expect(text).toContain('-old-line-1');
			expect(text).toContain('+new-line-1');
			// The trailing add (no paired remove) still renders.
			expect(text).toContain('+new-line-3');
			// Context lines render (once per side).
			expect(text.match(/ context-1/g)?.length).toBe(2);
			expect(text.match(/ context-2/g)?.length).toBe(2);
			// The hunk header renders once.
			expect(text.match(/@@ -1,4 \+1,5 @@/g)?.length).toBe(1);
		});
	});

	describe('Back button', () => {
		it('calls onBack when the back button is clicked', () => {
			const onBack = vi.fn();
			render(<GitDiffViewer diff={SAMPLE_DIFF} filePath="file.txt" onBack={onBack} />);

			fireEvent.click(screen.getByRole('button', { name: /back/i }));
			expect(onBack).toHaveBeenCalledTimes(1);
		});
	});
});
