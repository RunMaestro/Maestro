import type { ReactNode } from 'react';
import type { EncoreFeatureFlags } from '../../../../types';
import { ExtensionsView } from '../../Extensions/ExtensionsView';
import { ENCORE_SECTIONS } from './sections';
import type { EncoreTabProps } from './types';

export type { EncoreTabProps } from './types';

/**
 * The Plugins tab. The Extensions marketplace IS the tab - every built-in
 * feature and community plugin is a managed tile. Per-feature configuration
 * lives INSIDE each tile's detail pane (a Settings sub-tab), not in a separate
 * list. This component hands the marketplace a `settingsBodies` map keyed by
 * Encore flag; ExtensionDetails renders the matching body in its Settings
 * sub-tab. Each body owns its own state (see sections.tsx).
 */
export function EncoreTab({ theme, isOpen, tileRequest }: EncoreTabProps) {
	const settingsBodies: Partial<Record<keyof EncoreFeatureFlags, ReactNode>> = {};
	for (const { flag, Component } of ENCORE_SECTIONS) {
		settingsBodies[flag] = <Component theme={theme} isOpen={isOpen} />;
	}

	return (
		<div className="space-y-5">
			<ExtensionsView theme={theme} settingsBodies={settingsBodies} tileRequest={tileRequest} />
		</div>
	);
}
