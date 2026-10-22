/**
 * LocalModelsProxyUsage - what the Maestro token proxy carried and what it
 * shortened, under the Gateway table.
 *
 * Three parts, all read from one report (`useTokenProxyReport`):
 *
 * - the listener: its address, or why it is not up;
 * - totals for the last 30 days, in all and per agent: tokens saved and the
 *   time requests were held. Both cover only requests whose body the proxy
 *   read (`compress` mode); a passthrough request counts as a request and
 *   nothing else;
 * - "Recent compressions": the blocks it last shortened. A row opens a diff of
 *   what the agent sent against what went out in its place, both read from the
 *   content-addressed cache, so every change the proxy made can be checked.
 *
 * Nothing here changes a setting. The mode control is in the Gateway table.
 */

import { useCallback, useState } from 'react';

import { formatCount, formatRelativeTime } from '../../../../../shared/formatters';
import {
	describeAddedLatency,
	describeTokensSaved,
	TOKEN_PROXY_ESTIMATE_NOTE,
	TOKEN_PROXY_HOST,
	type TokenProxyBlockDetail,
	type TokenProxyReport,
} from '../../../../../shared/local-models/token-proxy';
import type { ProxyCompressionEntry } from '../../../../../shared/stats-types';
import type { Theme } from '../../../../types';
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
							<td className="py-1 pr-3 font-medium" style={{ color: theme.colors.textMain }}>
								All agents
							</td>
							<td className="py-1 pr-3 text-right">{formatCount(usage.totals.requests)}</td>
							<td className="py-1 pr-3 text-right">{describeTokensSaved(usage.totals)}</td>
							<td className="py-1 text-right">{describeAddedLatency(usage.totals)}</td>
						</tr>
						{usage.byAgent.map((row) => (
							<tr
								key={row.agentId ?? 'no-agent'}
								data-testid="token-proxy-usage-agent"
								data-agent-id={row.agentId ?? ''}
							>
								<td className="py-1 pr-3">{nameOf(row.agentId)}</td>
								<td className="py-1 pr-3 text-right">{formatCount(row.requests)}</td>
								<td className="py-1 pr-3 text-right">{describeTokensSaved(row)}</td>
								<td className="py-1 text-right">{describeAddedLatency(row)}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}

			{usage && usage.totals.compressRequests > 0 && (
				<p className="text-xs opacity-70" data-testid="token-proxy-estimate-note">
					{TOKEN_PROXY_ESTIMATE_NOTE}
				</p>
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
			{state.status === 'ready' &&
				(state.block.original === null ? (
					<p className="text-xs opacity-70" data-testid="token-proxy-compression-no-original">
						The original text is no longer in the cache. The text that was sent in its place is
						still stored under this hash.
					</p>
				) : (
					<div
						className="mt-1 max-h-96 overflow-auto rounded border"
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
				))}
		</li>
	);
}
