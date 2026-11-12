/**
 * TokenProxyObservations - what the Maestro token proxy has observed since the
 * app started, apart from anything it measured in a date range:
 *
 * - the originals read back, by caller (`TokenProxyRecoveryObservations`);
 * - the read opportunities: what the proxy could have shortened and did not
 *   (`TokenProxyReadOpportunities`), with the newest previews it built and left
 *   unused. A preview opens to its text and to the facts that qualify its figure.
 *
 * Both are observation. Nothing here was applied, nothing is a saving, and none
 * of it is added to the range totals. The sentences come from
 * `src/shared/local-models/token-proxy-report.ts`, the words `maestro-cli models
 * proxy status` prints, so a surface cannot say a count or its certainty
 * differently. The surface that mounts this owns the read (it already holds the
 * report) and says where the figures sit; this component fetches nothing and
 * has no timer.
 *
 * Either part may be absent: an older desktop sends neither.
 */

import { useId, useState } from 'react';

import { formatCount, formatRelativeTime } from '../../../shared/formatters';
import {
	TOKEN_PROXY_OPPORTUNITY_NOTE,
	type TokenProxyOpportunity,
	type TokenProxyReadOpportunities,
	type TokenProxyRecoveryObservations,
} from '../../../shared/local-models/token-proxy';
import {
	describeOpportunityIdentity,
	describeOpportunityKind,
	describeOpportunityPreview,
	describeProxyOpportunities,
	describeProxyRecovery,
	TOKEN_PROXY_RECOVERY_HEADING,
} from '../../../shared/local-models/token-proxy-report';
import type { Theme } from '../../types';
import { ProxyReportLines } from './ProxyReportLines';

export interface TokenProxyObservationsProps {
	theme: Theme;
	opportunities?: TokenProxyReadOpportunities;
	recovery?: TokenProxyRecoveryObservations;
	/** The name of the agent a preview came from. The default names its id. */
	nameOf?: (agentId: string | null) => string;
}

function defaultAgentName(agentId: string | null): string {
	return agentId === null ? 'No agent (started outside the app)' : `Agent ${agentId.slice(0, 8)}`;
}

function previewKey(entry: TokenProxyOpportunity): string {
	return `${entry.observedAt}:${entry.kind}:${entry.callId ?? ''}:${entry.sourceHash}`;
}

interface OpportunityRowProps {
	theme: Theme;
	entry: TokenProxyOpportunity;
	agentName: string;
}

/** One preview, closed to a line and open to its facts and its text. */
function OpportunityRow({ theme, entry, agentName }: OpportunityRowProps) {
	const [open, setOpen] = useState(false);
	const detailId = useId();
	const { potential } = entry;
	return (
		<li data-testid="token-proxy-opportunity" data-kind={entry.kind}>
			<button
				type="button"
				className="w-full text-left text-xs flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1"
				style={{ color: theme.colors.textMain }}
				onClick={() => setOpen((current) => !current)}
				aria-expanded={open}
				aria-controls={open ? detailId : undefined}
				data-testid="token-proxy-opportunity-toggle"
			>
				<span className="font-medium">{describeOpportunityKind(entry.kind)}</span>
				<span className="font-mono break-all">{entry.path}</span>
				<span>
					{formatCount(potential.fullTokens)} to {formatCount(potential.previewTokens)} tokens
					(potential)
				</span>
				<span className="opacity-70">{agentName}</span>
				<span className="opacity-70">{formatRelativeTime(entry.observedAt)}</span>
				<span className="underline ml-auto">{open ? 'Hide preview' : 'Show preview'}</span>
			</button>
			{open && (
				<div id={detailId} className="space-y-2 pb-2" data-testid="token-proxy-opportunity-detail">
					<ProxyReportLines lines={describeOpportunityPreview(entry)} />
					<pre
						className="max-h-64 overflow-auto rounded border p-2 font-mono text-xs whitespace-pre-wrap break-words select-text"
						style={{ borderColor: theme.colors.border }}
						data-testid="token-proxy-opportunity-text"
					>
						{entry.text}
					</pre>
				</div>
			)}
		</li>
	);
}

function RecoveryObservations({
	theme,
	recovery,
}: {
	theme: Theme;
	recovery: TokenProxyRecoveryObservations;
}) {
	return (
		<section className="space-y-1" data-testid="token-proxy-recovery">
			<h4 className="font-medium" style={{ color: theme.colors.textMain }}>
				{TOKEN_PROXY_RECOVERY_HEADING}
			</h4>
			<ProxyReportLines
				lines={describeProxyRecovery(recovery)}
				testId="token-proxy-recovery-lines"
			/>
		</section>
	);
}

function ReadOpportunities({
	theme,
	opportunities,
	nameOf,
}: {
	theme: Theme;
	opportunities: TokenProxyReadOpportunities;
	nameOf: (agentId: string | null) => string;
}) {
	const { coverage, recent } = opportunities;
	return (
		<section className="space-y-2" data-testid="token-proxy-opportunities">
			<h4 className="font-medium" style={{ color: theme.colors.textMain }}>
				Read opportunities since the app started (observation only, none of it was applied)
			</h4>
			<p className="opacity-70" data-testid="token-proxy-opportunity-note">
				{TOKEN_PROXY_OPPORTUNITY_NOTE}
			</p>
			{coverage.observed === 0 && (
				<p data-testid="token-proxy-opportunity-none">
					No request has been examined since the app started. A request is examined only when its
					agent is in a compress mode, so there is nothing to compare yet.
				</p>
			)}
			<ProxyReportLines
				lines={describeProxyOpportunities(opportunities)}
				testId="token-proxy-opportunity-lines"
			/>
			<p className="opacity-70" data-testid="token-proxy-opportunity-identity">
				Not available: {describeOpportunityIdentity(opportunities.identity)}
			</p>
			{recent.length > 0 ? (
				<div className="space-y-1" data-testid="token-proxy-opportunity-recent">
					<div className="font-medium" style={{ color: theme.colors.textMain }}>
						Recent previews
					</div>
					<ul className="space-y-1">
						{recent.map((entry) => (
							<OpportunityRow
								key={previewKey(entry)}
								theme={theme}
								entry={entry}
								agentName={nameOf(entry.agentId)}
							/>
						))}
					</ul>
				</div>
			) : (
				<p className="opacity-70" data-testid="token-proxy-opportunity-no-previews">
					No preview has been built yet.
				</p>
			)}
		</section>
	);
}

export function TokenProxyObservations({
	theme,
	opportunities,
	recovery,
	nameOf = defaultAgentName,
}: TokenProxyObservationsProps) {
	if (!opportunities && !recovery) {
		return (
			<p className="text-xs opacity-70" data-testid="token-proxy-observations-none">
				This desktop sent no observations.
			</p>
		);
	}
	return (
		<div className="space-y-4 text-xs select-text" data-testid="token-proxy-observations">
			{recovery && <RecoveryObservations theme={theme} recovery={recovery} />}
			{opportunities && (
				<ReadOpportunities theme={theme} opportunities={opportunities} nameOf={nameOf} />
			)}
		</div>
	);
}
