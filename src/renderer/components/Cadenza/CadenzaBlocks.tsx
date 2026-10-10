/**
 * CadenzaBlocks - adapter that renders a `view` cadenza's JSON block spec.
 * Parses the agent-authored JSON string and hands it to the shared BlockView
 * engine (the composable, theme-styled block renderer). All block kinds, layout,
 * and styling live in BlockView; this only owns the string parse + error UI.
 */

import { memo } from 'react';
import type { Theme } from '../../types';
import { BlockView, type BlockSpec } from '../BlockView';

export const CadenzaBlocks = memo(function CadenzaBlocks({
	spec,
	theme,
}: {
	spec: string;
	theme: Theme;
}) {
	let parsed: BlockSpec;
	try {
		parsed = JSON.parse(spec) as BlockSpec;
	} catch {
		return (
			<div className="text-xs font-mono" style={{ color: theme.colors.error }}>
				Invalid view JSON
			</div>
		);
	}

	return <BlockView spec={parsed} theme={theme} />;
});
