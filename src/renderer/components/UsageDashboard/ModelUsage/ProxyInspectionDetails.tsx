/** Explicit inspection, separate from the dashboard's range and realized counters. */
import { memo, useEffect, useRef, useState } from 'react';
import { FileSearch, RefreshCw, ScrollText } from 'lucide-react';
import {
	formatContextFootprint,
	type ContextFootprintAudit,
} from '../../../../shared/contextFootprint';
import { formatTimestamp } from '../../../../shared/formatters';
import { useTokenProxyReport } from '../../../hooks/localModels/useTokenProxyReport';
import { selectSessionById, useSessionStore } from '../../../stores/sessionStore';
import { useModalStore } from '../../../stores/modalStore';
import { ipcErrorMessage } from '../../../utils/ipcErrorMessage';
import { isAiTabHidden } from '../../../utils/unifiedTabOrderUtils';
import type { Theme } from '../../../types';
import { HeaderActionButton } from '../../ui/HeaderActionButton';
import { TokenProxyObservations } from '../../shared/TokenProxyObservations';

interface InspectionAgent {
	id: string;
	name: string;
}

function AgentAudit({ theme, agent }: { theme: Theme; agent: InspectionAgent }) {
	const [snapshot, setSnapshot] = useState<{
		audit: ContextFootprintAudit;
		loadedAt: number;
	} | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const request = useRef(0);
	useEffect(
		() => () => {
			request.current++;
		},
		[]
	);
	const read = async () => {
		const current = ++request.current;
		setLoading(true);
		try {
			const next = await window.maestro.context.getFootprint(agent.id);
			if (current !== request.current) return;
			if (next.subject.agentId !== agent.id)
				throw new Error('The audit returned a different agent');
			setSnapshot({ audit: next, loadedAt: Date.now() });
			setError(null);
		} catch (error) {
			if (current === request.current) setError(ipcErrorMessage(error));
		} finally {
			if (current === request.current) setLoading(false);
		}
	};
	return (
		<section className="space-y-2" aria-label="Selected agent context inventory">
			<div className="flex flex-wrap items-center gap-2">
				<HeaderActionButton
					theme={theme}
					variant="ghost"
					icon={<FileSearch />}
					onClick={() => void read()}
					disabled={loading}
					testId="proxy-audit-read"
				>
					{loading ? 'Reading inventory' : `Audit ${agent.name}`}
				</HeaderActionButton>
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					{agent.id}
				</span>
			</div>
			<p className="text-xs" style={{ color: theme.colors.textDim }}>
				On-demand file inventory and configured-text estimates for this agent. Delivery and current
				context-window membership remain unknown. These figures are not savings.
			</p>
			{error && (
				<p role="alert" className="text-xs" style={{ color: theme.colors.error }}>
					{error}
					{snapshot ? ' The previous inventory snapshot is still shown.' : ''}
				</p>
			)}
			{snapshot && (
				<>
					<p className="text-xs" style={{ color: theme.colors.textDim }}>
						Inventory loaded {formatTimestamp(snapshot.loadedAt)}.
					</p>
					<pre
						data-testid="proxy-audit-text"
						className="font-mono text-xs whitespace-pre-wrap break-words max-h-80 overflow-auto select-text"
						style={{ color: theme.colors.textMain }}
					>
						{formatContextFootprint(snapshot.audit)}
					</pre>
				</>
			)}
		</section>
	);
}

/** Mounted only while the user has opened the disclosure; no closed-panel fetch or timer. */
function InspectionBody({ theme, agent }: { theme: Theme; agent: InspectionAgent | null }) {
	const { report, loading, error, refresh } = useTokenProxyReport();
	const tabId = useSessionStore((state) => {
		const session = agent ? selectSessionById(agent.id)(state) : undefined;
		// getActiveTab intentionally falls back to another tab. An evidence preview
		// must bind the selected ID exactly instead of silently choosing a substitute.
		return (
			session?.aiTabs.find((tab) => tab.id === session.activeTabId && !isAiTabHidden(tab))?.id ??
			null
		);
	});
	return (
		<div className="space-y-4 pt-3" data-testid="proxy-inspection-body">
			<section className="space-y-2" aria-label="App-lifetime proxy observations">
				<div className="flex flex-wrap items-center gap-2">
					<HeaderActionButton
						theme={theme}
						variant="ghost"
						icon={<RefreshCw />}
						onClick={() => void refresh()}
						disabled={loading}
						testId="proxy-observations-refresh"
					>
						{loading ? 'Reading observations' : 'Refresh observations'}
					</HeaderActionButton>
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						App lifetime, all agents. Independent of the dashboard date range.
					</span>
				</div>
				{error && (
					<p role="alert" className="text-xs" style={{ color: theme.colors.error }}>
						{error}
						{report ? ' The previous observations snapshot is still shown.' : ''}
					</p>
				)}
				{report && (
					<TokenProxyObservations
						theme={theme}
						opportunities={report.readOpportunities}
						recovery={report.recovery}
					/>
				)}
			</section>
			{agent ? (
				<AgentAudit key={agent.id} theme={theme} agent={agent} />
			) : (
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					Select an AI agent to audit its inventory or preview an AI tab.
				</p>
			)}
			<div className="space-y-2">
				<HeaderActionButton
					theme={theme}
					variant="ghost"
					icon={<ScrollText />}
					disabled={!agent || !tabId}
					testId="proxy-continuity-preview"
					onClick={() => {
						if (agent && tabId)
							useModalStore
								.getState()
								.openModal('continuityPreview', { sessionId: agent.id, tabId });
					}}
				>
					Preview continuity for the selected AI tab
				</HeaderActionButton>
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					Read-only evidence for that tab: repeated failures, context pressure and configured
					routing, with unknowns preserved. Quality remains not evaluated.{' '}
					{agent && !tabId ? 'This agent has no selected AI tab.' : ''}
				</p>
			</div>
		</div>
	);
}

export const ProxyInspectionDetails = memo(function ProxyInspectionDetails({
	theme,
	agent,
}: {
	theme: Theme;
	agent: InspectionAgent | null;
}) {
	const [open, setOpen] = useState(false);
	return (
		<details
			className="mt-4 border-t pt-3"
			style={{ borderColor: theme.colors.border }}
			data-testid="proxy-inspection-details"
			onToggle={(event) => setOpen(event.currentTarget.open)}
		>
			<summary className="text-xs cursor-pointer" style={{ color: theme.colors.accentText }}>
				Inspect opportunities, context inventory and continuity
			</summary>
			{open && <InspectionBody theme={theme} agent={agent} />}
		</details>
	);
});
