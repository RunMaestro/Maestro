/**
 * LocalModelsProxyUsage - what the Maestro token proxy carried and what it
 * shortened, under the Gateway table, and how to check it.
 *
 * Everything is read from one report (`useTokenProxyReport`) and worded by
 * `token-proxy-report.ts`, the sentences `maestro-cli models proxy status`
 * prints:
 *
 * - the listener: its address, or why it is not up;
 * - totals for the last 30 days, in all, per agent, per request mode and per
 *   provider route: tokens saved and the time requests were held. Both cover
 *   only requests whose body the proxy read (`compress` mode); a passthrough
 *   request counts as a request and nothing else;
 * - "Diagnostics": how those requests were handled (read, shortened, set aside,
 *   forwarded unread and why), each count with the share of requests it covers;
 * - "Recent compressions": the blocks it last shortened. A row opens a diff of
 *   what the agent sent against what went out in its place, both read from the
 *   content-addressed cache, so every change the proxy made can be checked. It
 *   also names the cache key and the CLI command that prints the exact original;
 * - "Recovery and read opportunities": the originals read back and the
 *   previews the proxy built and did not use, since the app started (not part
 *   of the 30 days).
 *
 * Nothing here changes a setting, and nothing reads on its own: a closed
 * disclosure draws nothing, and the figures change when Refresh reads the report
 * again. The mode control is in the Gateway table.
 */

import { useCallback, useId, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

import { formatCount, formatRelativeTime } from '../../../../../shared/formatters';
import {
	describeAddedLatency,
	describeTokensSaved,
	TOKEN_PROXY_ESTIMATE_NOTE,
	TOKEN_PROXY_EVIDENCE_SEPARATION_NOTE,
	TOKEN_PROXY_HOST,
	type TokenProxyBlockDetail,
	type TokenProxyReport,
} from '../../../../../shared/local-models/token-proxy';
import {
	describeProviderUsage,
	describeProviderUsageNote,
	describeProxyEffectiveness,
	describeProxyMode,
	describeProxyRoute,
	describeProxyTrend,
	TOKEN_PROXY_RESULTS_NOT_EVALUATED_NOTE,
	TOKEN_PROXY_TOTALS_ONLY_NOTE,
	TOKEN_PROXY_TREND_NOTE,
} from '../../../../../shared/local-models/token-proxy-report';
import type {
	ProxyCompressionEntry,
	ProxyRequestTotals,
	ProxyRequestUsage,
} from '../../../../../shared/stats-types';
import type { Theme } from '../../../../types';
import { ProxyReportLines } from '../../../shared/ProxyReportLines';
import { TokenProxyObservations } from '../../../shared/TokenProxyObservations';
import { CopyIconButton } from '../../../ui/CopyIconButton';
import { TextDiff } from '../../../ui/TextDiff';
import { SectionCard } from '../DisplayTab/components/SectionCard';

export interface LocalModelsProxyUsageProps {
	theme: Theme;
	report: TokenProxyReport | null;
	loading: boolean;
	error: string | null;
	onRefresh: () => void;
	/** Agent id -> name, for agents the report does not name itself. */
	agentNames: Record<string, string>;
}

/** The listener, in one line. */
export function describeProxyListener(report: TokenProxyReport): string {
	const { status } = report;
	if (status.port === null) {
		return 'Not set up. Choose Passthrough or Compress for an agent to turn it on.';
	}
	const address = `${TOKEN_PROXY_HOST}:${status.port}`;
	if (status.running) {
		const count = status.agentIds.length;
		return `Listening on ${address} for ${count} ${count === 1 ? 'agent' : 'agents'}.`;
	}
	if (status.lastError) return `Could not start on ${address}: ${status.lastError}.`;
	return `Stopped. It starts on ${address} when an agent uses it.`;
}

interface DisclosureProps {
	theme: Theme;
	title: string;
	/** What span the figures inside cover. */
	scope: string;
	testId: string;
	children: ReactNode;
}

/**
 * A title that opens a body. The body is not drawn while closed, so a closed
 * disclosure costs the card nothing and reads nothing.
 */
function Disclosure({ theme, title, scope, testId, children }: DisclosureProps) {
	const [open, setOpen] = useState(false);
	const bodyId = useId();
	return (
		<div data-testid={testId}>
			<button
				type="button"
				className="w-full text-left text-xs flex items-baseline gap-2 py-1 rounded focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2"
				style={{ color: theme.colors.textMain, outlineColor: theme.colors.accent }}
				onClick={() => setOpen((current) => !current)}
				aria-expanded={open}
				aria-controls={open ? bodyId : undefined}
				data-testid={`${testId}-toggle`}
			>
				<ChevronRight
					className={`w-3.5 h-3.5 shrink-0 self-center transition-transform ${open ? 'rotate-90' : ''}`}
					style={{ color: theme.colors.accent }}
					aria-hidden="true"
				/>
				<span className="font-medium">{title}</span>
				<span className="opacity-70">{scope}</span>
			</button>
			{open && (
				<div id={bodyId} className="mt-1 ml-5 space-y-2 text-xs select-text">
					{children}
				</div>
			)}
		</div>
	);
}

/**
 * How the last 30 days were handled, from the same counts the CLI prints: what
 * the proxy read, shortened and set aside, why a request was forwarded unread, the
 * time it held requests, and the days that hold data. Each line says how many
 * requests it covers, and a count nothing supplied is unknown and never 0.
 */
function ProxyDiagnostics({ usage }: { usage: ProxyRequestUsage }) {
	const { effectiveness } = usage;
	if (!effectiveness) {
		return (
			<p className="opacity-70" data-testid="token-proxy-diagnostics-older">
				{TOKEN_PROXY_TOTALS_ONLY_NOTE}
			</p>
		);
	}
	const days = describeProxyTrend(effectiveness.trend);
	const earlier = effectiveness.trend.length - days.length;
	return (
		<>
			<p className="opacity-70">
				Counts Maestro made on the requests of the last 30 days, each with the share of requests it
				covers. A count that covers none is unknown, not zero.
			</p>
			<ProxyReportLines
				lines={describeProxyEffectiveness(effectiveness)}
				testId="token-proxy-diagnostics-lines"
			/>
			{days.length > 0 && (
				<div className="space-y-1" data-testid="token-proxy-diagnostics-days">
					<div className="font-medium">Recent days</div>
					<ProxyReportLines lines={days} />
					<p className="opacity-70">
						{TOKEN_PROXY_TREND_NOTE}
						{earlier > 0
							? ` ${formatCount(earlier)} earlier ${earlier === 1 ? 'day' : 'days'} in the range ${earlier === 1 ? 'is' : 'are'} not listed here.`
							: ''}
					</p>
				</div>
			)}
			<p className="opacity-70">{TOKEN_PROXY_EVIDENCE_SEPARATION_NOTE}</p>
		</>
	);
}

/** The figures of a group of requests, in the cells of the totals table. */
function UsageCells({
	theme,
	label,
	totals,
	strong = false,
}: {
	theme: Theme;
	label: string;
	totals: ProxyRequestTotals;
	/** The row for all requests: its label is the heading of the rows below it. */
	strong?: boolean;
}) {
	return (
		<>
			<td
				className={strong ? 'py-1 pr-3 font-medium' : 'py-1 pr-3'}
				style={strong ? { color: theme.colors.textMain } : undefined}
			>
				{label}
			</td>
			<td className="py-1 pr-3 text-right">{formatCount(totals.requests)}</td>
			<td className="py-1 pr-3 text-right">{describeTokensSaved(totals)}</td>
			<td className="py-1 text-right">{describeAddedLatency(totals)}</td>
		</>
	);
}

/** A cut of the same requests (by request mode, by provider route), under its own heading. */
function UsageGroup({ title, children }: { title: string; children: ReactNode }) {
	return (
		<tbody>
			<tr>
				<th colSpan={4} scope="rowgroup" className="text-left font-medium opacity-70 pt-3 pb-1">
					{title}
				</th>
			</tr>
			{children}
		</tbody>
	);
}

export function LocalModelsProxyUsage({
	theme,
	report,
	loading,
	error,
	onRefresh,
	agentNames,
}: LocalModelsProxyUsageProps) {
	const nameOf = useCallback(
		(agentId: string | null): string => {
			if (agentId === null) return 'No agent (started outside the app)';
			return (
				report?.agents.find((agent) => agent.id === agentId)?.name ??
				agentNames[agentId] ??
				`Removed agent ${agentId.slice(0, 8)}`
			);
		},
		[report, agentNames]
	);

	const usage = report?.usage ?? null;
	const providerUsage = useMemo(
		() =>
			usage
				? { note: describeProviderUsageNote(usage), lines: describeProviderUsage(usage) }
				: null,
		[usage]
	);

	return (
		<SectionCard theme={theme} className="space-y-3">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
						Maestro token proxy
					</div>
					<p className="text-xs opacity-70 select-text" data-testid="token-proxy-listener">
						{report ? describeProxyListener(report) : loading ? 'Loading...' : 'No report.'}
					</p>
				</div>
				<button
					type="button"
					className="text-xs underline flex-shrink-0 disabled:opacity-40"
					style={{ color: theme.colors.textMain }}
					onClick={onRefresh}
					disabled={loading}
					data-testid="token-proxy-refresh"
				>
					Refresh
				</button>
			</div>

			{error && (
				<p
					className="text-xs select-text"
					style={{ color: theme.colors.error }}
					data-testid="token-proxy-error"
				>
					{error}
				</p>
			)}

			{report && usage === null && (
				<p className="text-xs opacity-70" data-testid="token-proxy-usage-unavailable">
					Usage statistics are not available.
				</p>
			)}

			{usage && usage.totals.requests === 0 && (
				<p className="text-xs opacity-70" data-testid="token-proxy-usage-empty">
					No requests in the last 30 days.
				</p>
			)}

			{usage && usage.totals.requests > 0 && (
				<table className="w-full text-xs select-text" data-testid="token-proxy-usage-table">
					<thead>
						<tr>
							<th className="text-left font-medium opacity-70 pb-2 pr-3">Last 30 days</th>
							<th className="text-right font-medium opacity-70 pb-2 pr-3">Requests</th>
							<th
								className="text-right font-medium opacity-70 pb-2 pr-3"
								title={TOKEN_PROXY_ESTIMATE_NOTE}
							>
								Tokens saved (est.)
							</th>
							<th className="text-right font-medium opacity-70 pb-2">Average added latency</th>
						</tr>
					</thead>
					<tbody>
						<tr data-testid="token-proxy-usage-total">
							<UsageCells theme={theme} label="All agents" totals={usage.totals} strong />
						</tr>
						{usage.byAgent.map((row) => (
							<tr
								key={row.agentId ?? 'no-agent'}
								data-testid="token-proxy-usage-agent"
								data-agent-id={row.agentId ?? ''}
							>
								<UsageCells theme={theme} label={nameOf(row.agentId)} totals={row} />
							</tr>
						))}
					</tbody>
					{usage.byMode && usage.byMode.length > 0 && (
						<UsageGroup title="By request mode (what each request was carried as)">
							{usage.byMode.map((row) => (
								<tr
									key={row.effectiveMode ?? 'not-recorded'}
									data-testid="token-proxy-usage-mode"
									data-mode={row.effectiveMode ?? ''}
								>
									<UsageCells
										theme={theme}
										label={describeProxyMode(row.effectiveMode)}
										totals={row}
									/>
								</tr>
							))}
						</UsageGroup>
					)}
					{usage.byRoute && usage.byRoute.length > 0 && (
						<UsageGroup title="By provider route">
							{usage.byRoute.map((row) => (
								<tr key={row.route} data-testid="token-proxy-usage-route" data-route={row.route}>
									<UsageCells theme={theme} label={describeProxyRoute(row.route)} totals={row} />
								</tr>
							))}
						</UsageGroup>
					)}
				</table>
			)}

			{usage && usage.totals.compressRequests > 0 && (
				<p className="text-xs opacity-70" data-testid="token-proxy-estimate-note">
					{TOKEN_PROXY_ESTIMATE_NOTE}
				</p>
			)}

			{providerUsage && providerUsage.lines.length > 0 && (
				<div className="space-y-1 text-xs select-text" data-testid="token-proxy-provider-usage">
					<p className="opacity-70">{providerUsage.note}</p>
					<ProxyReportLines lines={providerUsage.lines} />
				</div>
			)}

			{usage && usage.totals.requests > 0 && (
				<p className="text-xs opacity-70" data-testid="token-proxy-results-note">
					{TOKEN_PROXY_RESULTS_NOT_EVALUATED_NOTE}
				</p>
			)}

			{usage && usage.totals.requests > 0 && (
				<Disclosure
					theme={theme}
					title="Diagnostics"
					scope="last 30 days: how the proxy handled these requests"
					testId="token-proxy-diagnostics"
				>
					<ProxyDiagnostics usage={usage} />
				</Disclosure>
			)}

			{report && report.recentCompressions.length > 0 && (
				<div className="space-y-1" data-testid="token-proxy-recent">
					<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
						Recent compressions
					</div>
					<ul className="space-y-1">
						{report.recentCompressions.map((entry) => (
							<CompressionRow
								key={entry.hash}
								theme={theme}
								entry={entry}
								agentName={nameOf(entry.agentId)}
							/>
						))}
					</ul>
				</div>
			)}

			{report && report.status.port !== null && (
				<Disclosure
					theme={theme}
					title="Recovery and read opportunities"
					scope="since the app started, all agents; not part of the last 30 days"
					testId="token-proxy-observations-disclosure"
				>
					<p className="opacity-70">
						A diff opened under Recent compressions is read through the same path as the CLI, so it
						counts as one of the other reads. Refresh to see the count change.
					</p>
					<TokenProxyObservations
						theme={theme}
						opportunities={report.readOpportunities}
						recovery={report.recovery}
						nameOf={nameOf}
					/>
				</Disclosure>
			)}
		</SectionCard>
	);
}

type BlockState =
	| { status: 'closed' }
	| { status: 'loading' }
	| { status: 'ready'; block: TokenProxyBlockDetail }
	| { status: 'missing' }
	| { status: 'error'; message: string };

interface CompressionRowProps {
	theme: Theme;
	entry: ProxyCompressionEntry;
	agentName: string;
}

function CompressionRow({ theme, entry, agentName }: CompressionRowProps) {
	const [state, setState] = useState<BlockState>({ status: 'closed' });
	const open = state.status !== 'closed';

	const toggle = useCallback(() => {
		if (open) {
			setState({ status: 'closed' });
			return;
		}
		setState({ status: 'loading' });
		window.maestro.localModels.proxy
			.block(entry.hash)
			.then((block) => {
				// A row closed while it loaded stays closed.
				setState((current) =>
					current.status !== 'loading'
						? current
						: block
							? { status: 'ready', block }
							: { status: 'missing' }
				);
			})
			.catch((err: unknown) => {
				setState((current) =>
					current.status !== 'loading'
						? current
						: { status: 'error', message: err instanceof Error ? err.message : String(err) }
				);
			});
	}, [open, entry.hash]);

	return (
		<li data-testid="token-proxy-compression" data-hash={entry.hash}>
			<button
				type="button"
				className="w-full text-left text-xs flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1"
				style={{ color: theme.colors.textMain }}
				onClick={toggle}
				aria-expanded={open}
				data-testid={`token-proxy-compression-toggle-${entry.hash}`}
			>
				<span className="font-mono">{entry.hash.slice(0, 12)}</span>
				<span>
					{formatCount(entry.originalTokens)} to {formatCount(entry.compressedTokens)} tokens
				</span>
				<span className="opacity-70">{entry.compressors.join(', ')}</span>
				<span className="opacity-70">{agentName}</span>
				<span className="opacity-70">{formatRelativeTime(entry.at)}</span>
				<span className="underline ml-auto">{open ? 'Hide diff' : 'Show diff'}</span>
			</button>
			{state.status === 'loading' && <p className="text-xs opacity-70">Loading...</p>}
			{state.status === 'missing' && (
				<p className="text-xs opacity-70" data-testid="token-proxy-compression-missing">
					The cache no longer holds this block.
				</p>
			)}
			{state.status === 'error' && (
				<p className="text-xs select-text" style={{ color: theme.colors.error }}>
					{state.message}
				</p>
			)}
			{state.status === 'ready' && (
				<div className="space-y-2 pb-1" data-testid="token-proxy-compression-detail">
					<div className="flex flex-wrap items-center gap-x-2 text-xs select-text">
						<span className="opacity-70">Cache key</span>
						<span className="font-mono break-all" data-testid="token-proxy-compression-key">
							{entry.hash}
						</span>
						<CopyIconButton
							value={entry.hash}
							theme={theme}
							title="Copy cache key"
							iconClassName="w-3.5 h-3.5"
							testId="token-proxy-compression-copy"
						/>
					</div>
					{state.block.original === null ? (
						<>
							<p className="text-xs opacity-70" data-testid="token-proxy-compression-no-original">
								The original text is no longer in the cache. The text that was sent in its place is
								still stored under this cache key, and is shown here.
							</p>
							<pre
								className="max-h-96 overflow-auto rounded border p-2 font-mono text-xs whitespace-pre-wrap break-words select-text"
								style={{ borderColor: theme.colors.border }}
								data-testid="token-proxy-compression-replacement"
							>
								{state.block.compressed}
							</pre>
						</>
					) : (
						<div
							className="max-h-96 overflow-auto rounded border"
							style={{ borderColor: theme.colors.border }}
							data-testid="token-proxy-compression-diff"
						>
							<TextDiff
								theme={theme}
								name="tool-result"
								before={state.block.original}
								after={state.block.compressed}
								emptyMessage="The stored texts are the same."
							/>
						</div>
					)}
					<p
						className="text-xs opacity-70 select-text"
						data-testid="token-proxy-compression-recover"
					>
						The exact original is also available as plain text:{' '}
						<code className="font-mono">
							maestro-cli models proxy block {entry.hash} --original
						</code>
						. Add <code className="font-mono">--lines 10:30</code> to read only those lines; the
						output says whether the range was complete.
					</p>
				</div>
			)}
		</li>
	);
}
