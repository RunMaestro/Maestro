/**
 * ProxyReportLines - the facts of one token proxy report as a definition list:
 * what each is called, and what it says.
 *
 * The lines come from `src/shared/local-models/token-proxy-report.ts`, which owns
 * the words and the certainty of every figure. This only lays them out, so the
 * Gateway section in Settings and the Models record draw one report the same way.
 * Text inherits the surface's color and the label dims once (`opacity-70`), the
 * Settings convention that clears the contrast floor in every theme.
 */

import { Fragment } from 'react';

import type { ProxyReportLine } from '../../../shared/local-models/token-proxy-report';

export interface ProxyReportLinesProps {
	lines: readonly ProxyReportLine[];
	testId?: string;
}

export function ProxyReportLines({ lines, testId }: ProxyReportLinesProps) {
	return (
		<dl
			className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs select-text"
			data-testid={testId}
		>
			{lines.map((line) => (
				<Fragment key={line.label}>
					<dt className="opacity-70">{line.label}</dt>
					<dd>{line.text}</dd>
				</Fragment>
			))}
		</dl>
	);
}
