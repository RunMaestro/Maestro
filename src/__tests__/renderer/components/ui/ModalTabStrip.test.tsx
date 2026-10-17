/**
 * Tests for ModalTabStrip, tabPanelProps, useModalTabs and useModalTabCycling.
 *
 * The strip replaces four hand-rolled tablists and the hook owns the one
 * Cmd/Ctrl+Shift+[ / ] cycling for modals. These pin the parts a caller relies
 * on without looking: aria wiring between tab and panel, the single tab stop,
 * arrow-key movement, the error dot, and the shortcut's enabled gate and memory.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, renderHook } from '@testing-library/react';
import { Cpu } from 'lucide-react';
import {
	ModalTabStrip,
	tabPanelProps,
	useModalTabs,
	__resetRememberedModalTabsForTests,
	type ModalTab,
} from '../../../../renderer/components/ui/ModalTabStrip';
import { mockTheme } from '../../../helpers/mockTheme';

type Id = 'general' | 'provider' | 'ssh';

const TABS: ModalTab<Id>[] = [
	{ id: 'general', label: 'General' },
	{ id: 'provider', label: 'Provider', icon: Cpu },
	{ id: 'ssh', label: 'SSH' },
];
const IDS: Id[] = ['general', 'provider', 'ssh'];

const renderStrip = (activeTab: Id, onChange = vi.fn(), tabs = TABS) => {
	render(
		<>
			<ModalTabStrip
				theme={mockTheme}
				tabs={tabs}
				activeTab={activeTab}
				onChange={onChange}
				label="Agent settings"
				idPrefix="edit-agent"
			/>
			<div {...tabPanelProps('edit-agent', activeTab)}>panel</div>
		</>
	);
	return onChange;
};

const pressCycle = (key: '[' | ']', extra: Partial<KeyboardEventInit> = {}) =>
	act(() => {
		fireEvent.keyDown(window, { key, metaKey: true, shiftKey: true, ...extra });
	});

describe('ModalTabStrip', () => {
	it('renders a labelled tablist with one tab per entry', () => {
		renderStrip('general');
		expect(screen.getByRole('tablist', { name: 'Agent settings' })).toBeInTheDocument();
		expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
			'General',
			'Provider',
			'SSH',
		]);
	});

	it('wires the active tab to its panel in both directions', () => {
		renderStrip('provider');
		const tab = screen.getByRole('tab', { name: /Provider/ });
		const panel = screen.getByRole('tabpanel');
		expect(tab).toHaveAttribute('aria-selected', 'true');
		expect(tab).toHaveAttribute('aria-controls', panel.id);
		expect(panel).toHaveAttribute('aria-labelledby', tab.id);
		expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'false');
	});

	it('keeps the strip to one tab stop, on the active tab', () => {
		renderStrip('provider');
		const stops = screen.getAllByRole('tab').map((t) => t.getAttribute('tabindex'));
		expect(stops).toEqual(['-1', '0', '-1']);
	});

	it('changes tab on click', () => {
		const onChange = renderStrip('general');
		fireEvent.click(screen.getByRole('tab', { name: 'SSH' }));
		expect(onChange).toHaveBeenCalledWith('ssh');
	});

	it('moves with the arrow keys, wrapping at both ends', () => {
		const onChange = renderStrip('general');
		const list = screen.getByRole('tablist');
		fireEvent.keyDown(list, { key: 'ArrowRight' });
		expect(onChange).toHaveBeenLastCalledWith('provider');
		fireEvent.keyDown(list, { key: 'ArrowLeft' });
		expect(onChange).toHaveBeenLastCalledWith('ssh');
	});

	it('jumps to the ends with Home and End, and moves focus there', () => {
		const onChange = renderStrip('provider');
		const list = screen.getByRole('tablist');
		fireEvent.keyDown(list, { key: 'End' });
		expect(onChange).toHaveBeenLastCalledWith('ssh');
		expect(screen.getByRole('tab', { name: 'SSH' })).toHaveFocus();
		fireEvent.keyDown(list, { key: 'Home' });
		expect(onChange).toHaveBeenLastCalledWith('general');
	});

	it('ignores other keys', () => {
		const onChange = renderStrip('general');
		fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Enter' });
		expect(onChange).not.toHaveBeenCalled();
	});

	// The strip scrolls sideways with no scrollbar, so a selected tab past its
	// edge has to be brought into view or nothing shows which panel is open.
	it('scrolls the selected tab into view, on mount and when the selection moves', () => {
		const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
		scrollIntoView.mockClear();
		const props = {
			theme: mockTheme,
			tabs: TABS,
			onChange: vi.fn(),
			label: 'Agent settings',
			idPrefix: 'edit-agent',
		};
		const { rerender } = render(<ModalTabStrip {...props} activeTab="ssh" />);

		expect(scrollIntoView).toHaveBeenCalledTimes(1);
		expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole('tab', { name: 'SSH' }));
		expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: 'auto', block: 'nearest' });

		rerender(<ModalTabStrip {...props} activeTab="general" />);
		expect(scrollIntoView).toHaveBeenCalledTimes(2);
		expect(scrollIntoView.mock.contexts[1]).toBe(screen.getByRole('tab', { name: 'General' }));

		// A render that does not move the selection scrolls nothing.
		rerender(<ModalTabStrip {...props} activeTab="general" />);
		expect(scrollIntoView).toHaveBeenCalledTimes(2);
	});

	it('draws an error dot only on a tab that has an error', () => {
		renderStrip('general', vi.fn(), [
			{ id: 'general', label: 'General', hasError: true },
			{ id: 'provider', label: 'Provider' },
			{ id: 'ssh', label: 'SSH' },
		]);
		const dot = screen.getByTestId('edit-agent-tab-general-error');
		expect(dot).toHaveStyle({ backgroundColor: mockTheme.colors.error });
		expect(screen.queryByTestId('edit-agent-tab-provider-error')).not.toBeInTheDocument();
		expect(screen.getByRole('tab', { name: /General/ })).toHaveTextContent('(has errors)');
	});
});

describe('tabPanelProps', () => {
	it('returns ids that match the strip for the same prefix', () => {
		expect(tabPanelProps('moderator', 'ssh')).toEqual({
			id: 'moderator-tabpanel-ssh',
			role: 'tabpanel',
			'aria-labelledby': 'moderator-tab-ssh',
		});
	});
});

describe('useModalTabs', () => {
	beforeEach(() => {
		__resetRememberedModalTabsForTests();
	});

	it('starts on the initial tab and switches on setActiveTab', () => {
		const { result } = renderHook(() =>
			useModalTabs({ tabs: IDS, initialTab: 'general', enabled: true })
		);
		expect(result.current.activeTab).toBe('general');
		act(() => result.current.setActiveTab('ssh'));
		expect(result.current.activeTab).toBe('ssh');
	});

	it('cycles with Cmd+Shift+[ and ], wrapping', () => {
		const { result } = renderHook(() =>
			useModalTabs({ tabs: IDS, initialTab: 'general', enabled: true })
		);
		pressCycle(']');
		expect(result.current.activeTab).toBe('provider');
		pressCycle('[');
		pressCycle('[');
		expect(result.current.activeTab).toBe('ssh');
		pressCycle(']');
		expect(result.current.activeTab).toBe('general');
	});

	it('accepts Ctrl and the shifted brace keys', () => {
		const { result } = renderHook(() =>
			useModalTabs({ tabs: IDS, initialTab: 'general', enabled: true })
		);
		act(() => {
			fireEvent.keyDown(window, { key: '}', ctrlKey: true, shiftKey: true });
		});
		expect(result.current.activeTab).toBe('provider');
	});

	it('does not cycle while disabled, or without Shift', () => {
		const { result, rerender } = renderHook(
			({ enabled }) => useModalTabs({ tabs: IDS, initialTab: 'general', enabled }),
			{ initialProps: { enabled: false } }
		);
		pressCycle(']');
		expect(result.current.activeTab).toBe('general');
		rerender({ enabled: true });
		pressCycle(']', { shiftKey: false });
		expect(result.current.activeTab).toBe('general');
	});

	it('remembers the last tab per key across remounts', () => {
		const first = renderHook(() =>
			useModalTabs({ tabs: IDS, initialTab: 'general', rememberKey: 'edit-agent', enabled: true })
		);
		act(() => first.result.current.setActiveTab('ssh'));
		first.unmount();

		const again = renderHook(() =>
			useModalTabs({ tabs: IDS, initialTab: 'general', rememberKey: 'edit-agent', enabled: true })
		);
		expect(again.result.current.activeTab).toBe('ssh');

		const otherKey = renderHook(() =>
			useModalTabs({ tabs: IDS, initialTab: 'general', rememberKey: 'moderator', enabled: true })
		);
		expect(otherKey.result.current.activeTab).toBe('general');
	});

	// A link that names a tab ("Open Peers tab") must land on it, whatever tab
	// the form was last left on.
	it('opens on a requested tab, ahead of the remembered one', () => {
		const first = renderHook(() =>
			useModalTabs({ tabs: IDS, initialTab: 'general', rememberKey: 'edit-agent', enabled: true })
		);
		act(() => first.result.current.setActiveTab('ssh'));
		first.unmount();

		const again = renderHook(() =>
			useModalTabs<Id>({
				tabs: IDS,
				initialTab: 'general',
				rememberKey: 'edit-agent',
				requestedTab: 'provider',
				enabled: true,
			})
		);
		expect(again.result.current.activeTab).toBe('provider');
	});

	it('ignores a requested tab that is not in the set', () => {
		const { result } = renderHook(() =>
			useModalTabs<Id>({
				tabs: ['general', 'provider'],
				initialTab: 'general',
				requestedTab: 'ssh',
				enabled: true,
			})
		);
		expect(result.current.activeTab).toBe('general');
	});

	it('does not remember without a key', () => {
		const first = renderHook(() =>
			useModalTabs({ tabs: IDS, initialTab: 'general', enabled: true })
		);
		act(() => first.result.current.setActiveTab('ssh'));
		first.unmount();
		const again = renderHook(() =>
			useModalTabs({ tabs: IDS, initialTab: 'general', enabled: true })
		);
		expect(again.result.current.activeTab).toBe('general');
	});

	it('falls back to the initial tab when the active one leaves the set', () => {
		const { result, rerender } = renderHook(
			({ tabs }) => useModalTabs<Id>({ tabs, initialTab: 'general', enabled: true }),
			{ initialProps: { tabs: IDS } }
		);
		act(() => result.current.setActiveTab('ssh'));
		rerender({ tabs: ['general', 'provider'] });
		expect(result.current.activeTab).toBe('general');
	});

	it('ignores a remembered tab that is not in the set', () => {
		const first = renderHook(() =>
			useModalTabs({ tabs: IDS, initialTab: 'general', rememberKey: 'k', enabled: true })
		);
		act(() => first.result.current.setActiveTab('ssh'));
		first.unmount();
		const again = renderHook(() =>
			useModalTabs<Id>({
				tabs: ['general', 'provider'],
				initialTab: 'provider',
				rememberKey: 'k',
				enabled: true,
			})
		);
		expect(again.result.current.activeTab).toBe('provider');
	});
});
