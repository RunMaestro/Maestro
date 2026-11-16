/**
 * Settings search view: turns a flat list of matching settings into the view
 * the search shows, one entry per Settings section.
 *
 * A search is a filtered view of Settings, not a list of links. Every matched
 * section appears once, already open, showing only the controls that matched;
 * a matched setting with no inline section (the theme picker, the shortcut
 * list, a feature that is off) stays a row that opens its tab. Several entries
 * that live in one section therefore never repeat that section.
 */

import type { SettingsStore } from '../../stores/settingsStore';
import { ALL_SEARCHABLE_SETTINGS, type SearchableSetting } from './searchableSettings';
import { findSettingsSection, type SettingsSectionDef } from './settingsSections';

/** A matched section, shown open with only its matched controls. */
export interface SettingsSearchPanel {
	kind: 'panel';
	/** The section key: unique across the view. */
	key: string;
	section: SettingsSectionDef;
	/** The tab the section lives on, for the card header. */
	tabLabel: string;
	/** The section's lead entry label (its first setting id). */
	title: string;
	/** The matched entries in this section, best match first. */
	matches: SearchableSetting[];
}

/** A matched setting with nothing to show in place: the row opens its tab. */
export interface SettingsSearchJump {
	kind: 'jump';
	key: string;
	setting: SearchableSetting;
}

export type SettingsSearchGroup = SettingsSearchPanel | SettingsSearchJump;

const SETTING_BY_ID = new Map(ALL_SEARCHABLE_SETTINGS.map((s) => [s.id, s] as const));

/** The section to show for `setting`, when there is one and it is available now. */
export function inlineSectionFor(
	setting: SearchableSetting,
	settings: SettingsStore
): SettingsSectionDef | undefined {
	const section = findSettingsSection(setting.id);
	if (!section) return undefined;
	return section.isAvailable && !section.isAvailable(settings) ? undefined : section;
}

/**
 * Collapse ranked results into one group per section. Groups keep the order of
 * their best match, so a section ranks where its strongest entry ranked.
 */
export function groupSearchResults(
	results: readonly SearchableSetting[],
	settings: SettingsStore
): SettingsSearchGroup[] {
	const groups: SettingsSearchGroup[] = [];
	const panels = new Map<string, SettingsSearchPanel>();
	for (const setting of results) {
		const section = inlineSectionFor(setting, settings);
		if (!section) {
			groups.push({ kind: 'jump', key: `jump:${setting.id}`, setting });
			continue;
		}
		const existing = panels.get(section.key);
		if (existing) {
			existing.matches.push(setting);
			continue;
		}
		const lead = SETTING_BY_ID.get(section.settingIds[0]) ?? setting;
		const panel: SettingsSearchPanel = {
			kind: 'panel',
			key: section.key,
			section,
			tabLabel: lead.tabLabel,
			title: lead.label,
			matches: [setting],
		};
		panels.set(section.key, panel);
		groups.push(panel);
	}
	return groups;
}

/** Where a search result goes when the user asks for its tab. */
export function groupNavigationTarget(group: SettingsSearchGroup): SearchableSetting {
	return group.kind === 'jump' ? group.setting : group.matches[0];
}

// ---------------------------------------------------------------------------
// Filtering a rendered section down to its matched controls
// ---------------------------------------------------------------------------

/** Set on an element the filter hides; `index.css` maps it to `display: none`. */
export const SEARCH_HIDDEN_ATTR = 'data-search-hidden';

const SETTING_SELECTOR = '[data-setting-id]';

function clearHidden(root: HTMLElement): void {
	root.removeAttribute(SEARCH_HIDDEN_ATTR);
	root
		.querySelectorAll(`[${SEARCH_HIDDEN_ATTR}]`)
		.forEach((el) => el.removeAttribute(SEARCH_HIDDEN_ATTR));
}

/**
 * Hide everything in a rendered section except the controls in `matched`.
 *
 * The anchors are the `data-setting-id` wrappers the section already renders.
 * A matched wrapper with no matched wrapper inside it is shown whole; a
 * matched wrapper that encloses other matched wrappers (a feature tile around
 * its options) only frames them. Any element that is neither inside a shown
 * wrapper nor on the path to one is hidden, so a card, heading or note left
 * with nothing under it goes too.
 *
 * Pass `null` to show the whole section. When no matched wrapper is rendered
 * (the control is mounted only in some states) the whole section is shown,
 * never an empty card.
 *
 * Returns the number of controls left visible.
 */
export function applySettingFilter(root: HTMLElement, matched: ReadonlySet<string> | null): number {
	if (!matched) {
		clearHidden(root);
		return root.querySelectorAll(SETTING_SELECTOR).length;
	}

	const wrappers = Array.from(root.querySelectorAll<HTMLElement>(SETTING_SELECTOR));
	const hits = wrappers.filter((el) => matched.has(el.dataset.settingId ?? ''));
	const shown = new Set(
		hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)))
	);
	if (shown.size === 0) {
		clearHidden(root);
		return wrappers.length;
	}

	const onPath = new Set<Element>();
	for (const el of shown) {
		for (let node = el.parentElement; node && node !== root; node = node.parentElement) {
			if (onPath.has(node)) break;
			onPath.add(node);
		}
	}

	const visit = (el: Element) => {
		if (shown.has(el as HTMLElement)) {
			clearHidden(el as HTMLElement);
			return;
		}
		if (onPath.has(el)) {
			el.removeAttribute(SEARCH_HIDDEN_ATTR);
			for (const child of Array.from(el.children)) visit(child);
			return;
		}
		el.setAttribute(SEARCH_HIDDEN_ATTR, '');
	};
	for (const child of Array.from(root.children)) visit(child);
	return shown.size;
}
