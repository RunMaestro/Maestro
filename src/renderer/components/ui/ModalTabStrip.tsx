/**
 * ModalTabStrip - one row of tabs across the top of a modal, plus the hook that
 * owns which tab is showing.
 *
 * Four surfaces hand-rolled this markup before it existed (`UsageDashboardTabs`,
 * `MergeSessionModal`, `SnoozedTabsModal`, `TabSwitcherModal`), and Settings
 * carried its own Cmd/Ctrl+Shift+[ / ] cycling. The visual treatment here is the
 * Usage Dashboard's (accent-tinted active tab); the cycling is the one Settings
 * used, now shared through `useModalTabCycling`.
 *
 * Usage:
 * ```tsx
 * const { activeTab, setActiveTab } = useModalTabs({
 *   tabs: ['general', 'provider'],
 *   initialTab: 'general',
 *   rememberKey: 'edit-agent',
 *   enabled: isOpen,
 * });
 * <ModalTabStrip theme={theme} tabs={TABS} activeTab={activeTab}
 *   onChange={setActiveTab} label="Agent settings" idPrefix="edit-agent" />
 * <div {...tabPanelProps('edit-agent', activeTab)}>...</div>
 * ```
 *
 * Keyboard: the strip is one tab stop (roving tabindex on the active tab).
 * Left / Right move between tabs and wrap, Home / End jump to the ends, and the
 * selection follows focus, the WAI-ARIA "automatic activation" pattern.
 */

import { useCallback, useEffect, useState, type ComponentType, type KeyboardEvent } from 'react';
import type { Theme } from '../../types';
import { eventMatchesShortcutKeys } from '../../utils/shortcutMatch';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { useScrollIntoView } from '../../hooks/ui/useScrollIntoView';

export interface ModalTab<Id extends string = string> {
	id: Id;
	label: string;
	/** Lucide icon, optional. */
	icon?: ComponentType<{ className?: string }>;
	/** Renders an error dot on the tab. */
	hasError?: boolean;
}

export interface ModalTabStripProps<Id extends string> {
	theme: Theme;
	tabs: ModalTab<Id>[];
	activeTab: Id;
	onChange: (id: Id) => void;
	/** aria-label for the tablist. */
	label: string;
	/** Prefix for tab/tabpanel element ids, so two strips on one page do not collide. */
	idPrefix: string;
	/** Extra classes for the strip row (padding, margins) where it is mounted. */
	className?: string;
	/** Keep the strip at the top of its scrolling panel, above the content. */
	sticky?: boolean;
}

function tabElementId(idPrefix: string, id: string): string {
	return `${idPrefix}-tab-${id}`;
}

function panelElementId(idPrefix: string, id: string): string {
	return `${idPrefix}-tabpanel-${id}`;
}

/**
 * The attributes a panel needs to be the target of its tab's `aria-controls`.
 * Spread onto the panel root: `<div {...tabPanelProps(prefix, id)}>`.
 */
export function tabPanelProps(
	idPrefix: string,
	id: string
): { id: string; role: 'tabpanel'; 'aria-labelledby': string } {
	return {
		id: panelElementId(idPrefix, id),
		role: 'tabpanel',
		'aria-labelledby': tabElementId(idPrefix, id),
	};
}

export function ModalTabStrip<Id extends string>({
	theme,
	tabs,
	activeTab,
	onChange,
	label,
	idPrefix,
	className = '',
	sticky = false,
}: ModalTabStripProps<Id>) {
	// The strip scrolls sideways and draws no scrollbar, so a selected tab past
	// its edge would be invisible: nothing on screen would say which panel is
	// showing. 'auto' because Left / Right can be held.
	const buttonRefs = useScrollIntoView<HTMLButtonElement>(
		true,
		tabs.findIndex((tab) => tab.id === activeTab),
		tabs.length,
		'auto'
	);

	const handleKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			if (tabs.length === 0) return;
			const current = Math.max(
				0,
				tabs.findIndex((tab) => tab.id === activeTab)
			);
			let next: number;
			switch (event.key) {
				case 'ArrowRight':
					next = (current + 1) % tabs.length;
					break;
				case 'ArrowLeft':
					next = (current - 1 + tabs.length) % tabs.length;
					break;
				case 'Home':
					next = 0;
					break;
				case 'End':
					next = tabs.length - 1;
					break;
				default:
					return;
			}
			event.preventDefault();
			onChange(tabs[next].id);
			buttonRefs.current[next]?.focus();
		},
		[tabs, activeTab, onChange, buttonRefs]
	);

	return (
		<div
			// Scrolls sideways rather than wrapping, like the Usage Dashboard strip:
			// six tabs do not fit a phone, and a wrapped row reads as two strips.
			className={`flex items-center gap-1 border-b overflow-x-auto no-scrollbar flex-shrink-0 ${sticky ? 'sticky top-0 z-20 pt-2' : ''} ${className}`}
			style={{
				borderColor: theme.colors.border,
				backgroundColor: sticky ? theme.colors.bgSidebar : undefined,
			}}
			role="tablist"
			aria-label={label}
			onKeyDown={handleKeyDown}
			data-testid={`${idPrefix}-tabs`}
		>
			{tabs.map((tab, index) => {
				const selected = tab.id === activeTab;
				const Icon = tab.icon;
				return (
					<button
						key={tab.id}
						ref={(el) => {
							buttonRefs.current[index] = el;
						}}
						type="button"
						role="tab"
						id={tabElementId(idPrefix, tab.id)}
						aria-selected={selected}
						aria-controls={panelElementId(idPrefix, tab.id)}
						tabIndex={selected ? 0 : -1}
						onClick={() => onChange(tab.id)}
						className="relative flex items-center gap-2 px-4 py-2 mb-2 rounded-lg text-sm font-medium transition-colors outline-none whitespace-nowrap shrink-0 focus-visible:ring-2"
						style={{
							backgroundColor: selected ? `${theme.colors.accent}20` : 'transparent',
							color: selected ? theme.colors.accent : theme.colors.textDim,
						}}
						onMouseEnter={(event) => {
							if (!selected) event.currentTarget.style.backgroundColor = `${theme.colors.accent}10`;
						}}
						onMouseLeave={(event) => {
							if (!selected) event.currentTarget.style.backgroundColor = 'transparent';
						}}
						data-testid={`${idPrefix}-tab-${tab.id}`}
					>
						{Icon && <Icon className="w-4 h-4 flex-shrink-0" />}
						<span>{tab.label}</span>
						{tab.hasError && (
							<>
								<span
									aria-hidden="true"
									className="w-1.5 h-1.5 rounded-full flex-shrink-0"
									style={{ backgroundColor: theme.colors.error }}
									data-testid={`${idPrefix}-tab-${tab.id}-error`}
								/>
								<span className="sr-only">(has errors)</span>
							</>
						)}
					</button>
				);
			})}
		</div>
	);
}

export interface UseModalTabCyclingOptions<Id extends string> {
	tabs: readonly Id[];
	activeTab: Id;
	onSelect: (id: Id) => void;
	/** Whether the shortcut is live (modal open and topmost). */
	enabled: boolean;
	/** Require Shift for top-level tabs; disable for nested tabs. Defaults to true. */
	shift?: boolean;
}

/**
 * Cmd/Ctrl+Shift+[ and ] step to the previous / next tab, wrapping at the ends.
 * Pass `shift: false` for Cmd/Ctrl+[ and ] on a nested tab strip.
 * The one implementation of that shortcut for modals: `useModalTabs` calls it,
 * and so does `SettingsModal`, whose tab state is too entangled with deep links
 * and search to hand to `useModalTabs` itself.
 */
export function useModalTabCycling<Id extends string>({
	tabs,
	activeTab,
	onSelect,
	enabled,
	shift = true,
}: UseModalTabCyclingOptions<Id>): void {
	useEventListener(
		'keydown',
		(event) => {
			const e = event as globalThis.KeyboardEvent;
			if (tabs.length === 0 || e.defaultPrevented) return;
			const modifiers = shift ? ['Meta', 'Shift'] : ['Meta'];
			const step = eventMatchesShortcutKeys(e, [...modifiers, '['])
				? -1
				: eventMatchesShortcutKeys(e, [...modifiers, ']'])
					? 1
					: 0;
			if (step === 0) return;
			e.preventDefault();
			e.stopPropagation();
			const current = tabs.indexOf(activeTab);
			const next =
				current === -1
					? step === 1
						? 0
						: tabs.length - 1
					: (current + step + tabs.length) % tabs.length;
			onSelect(tabs[next]);
		},
		// Modal stops bubbling keydowns at its backdrop, including those from
		// focused form controls. Capture the chord before it reaches that boundary.
		{ enabled, capture: true }
	);
}

// In-memory only, like Settings' `lastOpenSettingsTab`: the last tab per
// `rememberKey`, kept for the app session and forgotten on restart.
const rememberedModalTabs = new Map<string, string>();

/** Test-only: forget every remembered tab. */
export function __resetRememberedModalTabsForTests(): void {
	rememberedModalTabs.clear();
}

export interface UseModalTabsOptions<Id extends string> {
	tabs: readonly Id[];
	/** Tab to show on first open. */
	initialTab: Id;
	/** When set, the last active tab is remembered for this key for the app session. */
	rememberKey?: string;
	/**
	 * A tab the opener asked for by name. Read once, when the modal mounts, and
	 * it beats the remembered tab: a link that says "Peers" must land on Peers.
	 */
	requestedTab?: Id;
	/** Whether the Cmd+Shift+[ / ] cycling is live (modal open and topmost). */
	enabled: boolean;
}

export function useModalTabs<Id extends string>({
	tabs,
	initialTab,
	rememberKey,
	requestedTab,
	enabled,
}: UseModalTabsOptions<Id>): { activeTab: Id; setActiveTab: (id: Id) => void } {
	// Lazy init reads the remembered tab on mount, for the same reason Settings
	// does: a restore effect races the persist effect under StrictMode.
	const [selected, setSelected] = useState<Id>(() => {
		if (requestedTab !== undefined && tabs.includes(requestedTab)) return requestedTab;
		const remembered = rememberKey ? rememberedModalTabs.get(rememberKey) : undefined;
		return remembered !== undefined && (tabs as readonly string[]).includes(remembered)
			? (remembered as Id)
			: initialTab;
	});

	// A tab can leave the set while the modal is open (a mode switch hides it).
	// Show the initial tab instead of a strip with nothing selected.
	const activeTab = tabs.includes(selected) ? selected : initialTab;

	useEffect(() => {
		if (rememberKey) rememberedModalTabs.set(rememberKey, activeTab);
	}, [rememberKey, activeTab]);

	useModalTabCycling({ tabs, activeTab, onSelect: setSelected, enabled });

	return { activeTab, setActiveTab: setSelected };
}
