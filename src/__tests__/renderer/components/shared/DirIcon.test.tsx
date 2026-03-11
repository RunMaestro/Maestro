/**
 * @fileoverview Tests for DirIcon RTL-aware icon wrapper component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { DirIcon } from '../../../../renderer/components/shared/DirIcon';

// Mock settingsStore
const mockState = { language: 'en' };
vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: (selector: (s: typeof mockState) => unknown) => selector(mockState),
}));

// Mock i18n config (used by isRtlLanguage via DirectionProvider)
vi.mock('../../../../shared/i18n/config', () => ({
	RTL_LANGUAGES: ['ar'] as string[],
}));

// Create a mock Lucide icon component with a displayName in the flip list
function createMockIcon(displayName: string) {
	const MockIcon = vi.fn(({ className, ...rest }: { className?: string }) => (
		<svg data-testid="mock-icon" className={className} {...rest} />
	));
	MockIcon.displayName = displayName;
	// Cast to satisfy LucideIcon type — tests only care about render behavior
	return MockIcon as unknown as import('lucide-react').LucideIcon;
}

/** Helper: SVG elements return SVGAnimatedString for .className; use getAttribute instead. */
function getClass(el: Element): string | null {
	return el.getAttribute('class');
}

describe('DirIcon', () => {
	beforeEach(() => {
		mockState.language = 'en';
	});

	it('renders the icon component', () => {
		const Icon = createMockIcon('Settings');
		const { getByTestId } = render(<DirIcon icon={Icon} />);
		expect(getByTestId('mock-icon')).toBeTruthy();
	});

	it('passes className through in LTR mode', () => {
		const Icon = createMockIcon('ChevronRight');
		const { getByTestId } = render(<DirIcon icon={Icon} className="w-4 h-4" />);
		expect(getClass(getByTestId('mock-icon'))).toBe('w-4 h-4');
	});

	it('does not add rtl-flip class in LTR mode even for flip-list icons', () => {
		const Icon = createMockIcon('ChevronRight');
		const { getByTestId } = render(<DirIcon icon={Icon} className="w-4 h-4" />);
		expect(getClass(getByTestId('mock-icon'))).not.toContain('rtl-flip');
	});

	it('adds rtl-flip class in RTL mode for flip-list icons', () => {
		mockState.language = 'ar';
		const Icon = createMockIcon('ChevronRight');
		const { getByTestId } = render(<DirIcon icon={Icon} className="w-4 h-4" />);
		const cls = getClass(getByTestId('mock-icon'));
		expect(cls).toContain('rtl-flip');
		expect(cls).toContain('w-4 h-4');
	});

	it('adds rtl-flip without existing className in RTL mode', () => {
		mockState.language = 'ar';
		const Icon = createMockIcon('ArrowRight');
		const { getByTestId } = render(<DirIcon icon={Icon} />);
		expect(getClass(getByTestId('mock-icon'))).toBe('rtl-flip');
	});

	it('does not add rtl-flip for non-flip-list icons in RTL mode', () => {
		mockState.language = 'ar';
		const Icon = createMockIcon('Settings');
		const { getByTestId } = render(<DirIcon icon={Icon} className="w-4 h-4" />);
		const cls = getClass(getByTestId('mock-icon'));
		expect(cls).toBe('w-4 h-4');
		expect(cls).not.toContain('rtl-flip');
	});

	it('does not add rtl-flip for icons with no displayName', () => {
		mockState.language = 'ar';
		const Icon = createMockIcon('');
		const { getByTestId } = render(<DirIcon icon={Icon} />);
		expect(getClass(getByTestId('mock-icon'))).toBeNull();
	});

	it('passes extra props through to the icon', () => {
		const Icon = createMockIcon('Settings');
		const { getByTestId } = render(
			<DirIcon icon={Icon} data-testid="mock-icon" size={16} strokeWidth={2} />
		);
		const el = getByTestId('mock-icon');
		expect(el).toBeTruthy();
	});
});
