import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProxyInspectionDetails } from '../../../../renderer/components/UsageDashboard/ModelUsage/ProxyInspectionDetails';
import { ModelUsageStats } from '../../../../renderer/components/UsageDashboard/ModelUsage';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useModalStore } from '../../../../renderer/stores/modalStore';
import { auditContextFootprint, formatContextFootprint } from '../../../../shared/contextFootprint';
import type { ContextFootprintAudit } from '../../../../shared/contextFootprint';
import {
	proxyReport,
	readOpportunities,
	recoveryObservations,
} from '../../../helpers/proxyTelemetryFixtures';
import { EMPTY_MODEL_USAGE, currentProxyModelUsage } from '../../../helpers/modelUsageFixtures';
import { mockTheme } from '../../../helpers/mockTheme';
import { createMockSession } from '../../../helpers/mockSession';
import { createMockAITab } from '../../../helpers/mockTab';

const report = vi.fn();
const footprint = vi.fn();
const getModelUsage = vi.fn();
const alpha = { id: 'alpha', name: 'Alpha' };
const beta = { id: 'beta', name: 'Beta' };

function auditFor(agentId: string): ContextFootprintAudit {
	return auditContextFootprint({
		subject: {
			agentId,
			agentName: '<b>Literal name</b>',
			toolType: 'codex',
			projectRoot: '/fixture',
		},
		components: [],
		configured: [
			{
				id: 'nudge',
				label: 'Nudge',
				text: 'Configured text',
				frequency: 'every-message',
				source: 'saved setting',
			},
		],
		notes: [],
	});
}

async function openDetails() {
	const details = screen.getByTestId('proxy-inspection-details') as HTMLDetailsElement;
	act(() => {
		details.open = true;
		fireEvent(details, new Event('toggle'));
	});
	await screen.findByTestId('proxy-inspection-body');
	await waitFor(() => expect(screen.getByTestId('proxy-observations-refresh')).not.toBeDisabled());
}

beforeEach(() => {
	vi.clearAllMocks();
	useSessionStore.setState({ sessions: [], activeSessionId: '' });
	useModalStore.getState().closeAll();
	report.mockResolvedValue(proxyReport({ recovery: recoveryObservations() }));
	footprint.mockResolvedValue(auditFor('alpha'));
	getModelUsage.mockResolvedValue(currentProxyModelUsage());
	(window as unknown as { maestro: Record<string, unknown> }).maestro = {
		localModels: { proxy: { report } },
		context: { getFootprint: footprint },
		stats: { getModelUsage, onStatsUpdate: () => () => {} },
	};
});
afterEach(() => vi.useRealTimers());

describe('Models inspection details', () => {
	it('composes the shared recovery and opportunity preview without applying or fetching a replacement', async () => {
		const opportunities = readOpportunities();
		report.mockResolvedValueOnce(
			proxyReport({ readOpportunities: opportunities, recovery: recoveryObservations() })
		);
		render(<ProxyInspectionDetails theme={mockTheme} agent={alpha} />);
		await openDetails();
		expect(screen.getByTestId('token-proxy-recovery')).toBeInTheDocument();
		expect(screen.getByTestId('token-proxy-opportunities')).toHaveTextContent('412');
		fireEvent.click(screen.getByTestId('token-proxy-opportunity-toggle'));
		expect(screen.getByTestId('token-proxy-opportunity-text').textContent).toBe(
			opportunities.recent[0].text
		);
		expect(report).toHaveBeenCalledTimes(1);
		expect(footprint).not.toHaveBeenCalled();
	});

	it('makes no read while closed, reads observations once on opening, and reads inventory only on request', async () => {
		render(<ProxyInspectionDetails theme={mockTheme} agent={alpha} />);
		expect(report).not.toHaveBeenCalled();
		expect(footprint).not.toHaveBeenCalled();
		await openDetails();
		expect(report).toHaveBeenCalledTimes(1);
		expect(footprint).not.toHaveBeenCalled();
		expect(
			screen.getByText('App lifetime, all agents. Independent of the dashboard date range.')
		).toBeInTheDocument();
		fireEvent.click(screen.getByTestId('proxy-audit-read'));
		const text = await screen.findByTestId('proxy-audit-text');
		expect(footprint).toHaveBeenCalledExactlyOnceWith('alpha');
		expect(text.textContent).toBe(formatContextFootprint(auditFor('alpha')));
		expect(text.querySelector('b')).toBeNull();
		expect(text).toHaveTextContent('<b>Literal name</b>');
	});

	it('refreshes process observations deliberately, with no timer while open', async () => {
		render(<ProxyInspectionDetails theme={mockTheme} agent={alpha} />);
		await openDetails();
		fireEvent.click(screen.getByTestId('proxy-observations-refresh'));
		await waitFor(() => expect(report).toHaveBeenCalledTimes(2));
		vi.useFakeTimers();
		await act(async () => {
			vi.advanceTimersByTime(60_000);
		});
		expect(report).toHaveBeenCalledTimes(2);
		expect(footprint).not.toHaveBeenCalled();
	});

	it('unmounts the read owner on close and reads a fresh snapshot when reopened', async () => {
		render(<ProxyInspectionDetails theme={mockTheme} agent={null} />);
		await openDetails();
		const details = screen.getByTestId('proxy-inspection-details') as HTMLDetailsElement;
		act(() => {
			details.open = false;
			fireEvent(details, new Event('toggle'));
		});
		expect(screen.queryByTestId('proxy-inspection-body')).not.toBeInTheDocument();
		await openDetails();
		expect(report).toHaveBeenCalledTimes(2);
	});

	it('reports refresh failure without labelling the retained observations current', async () => {
		render(<ProxyInspectionDetails theme={mockTheme} agent={alpha} />);
		await openDetails();
		report.mockRejectedValueOnce(new Error('report unavailable'));
		fireEvent.click(screen.getByTestId('proxy-observations-refresh'));
		expect(await screen.findByRole('alert')).toHaveTextContent(
			'report unavailable The previous observations snapshot is still shown.'
		);
	});

	it('keeps audit failures visible and permits a retry', async () => {
		footprint.mockRejectedValueOnce(
			new Error("Error invoking remote method 'context:getFootprint': Error: agent unavailable")
		);
		render(<ProxyInspectionDetails theme={mockTheme} agent={alpha} />);
		await openDetails();
		fireEvent.click(screen.getByTestId('proxy-audit-read'));
		expect(await screen.findByRole('alert')).toHaveTextContent('agent unavailable');
		fireEvent.click(screen.getByTestId('proxy-audit-read'));
		await screen.findByTestId('proxy-audit-text');
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('clears the old inventory when the selected agent changes and discards its late answer', async () => {
		let resolve!: (value: ContextFootprintAudit) => void;
		footprint.mockImplementationOnce(
			() =>
				new Promise<ContextFootprintAudit>((r) => {
					resolve = r;
				})
		);
		const view = render(<ProxyInspectionDetails theme={mockTheme} agent={alpha} />);
		await openDetails();
		fireEvent.click(screen.getByTestId('proxy-audit-read'));
		view.rerender(<ProxyInspectionDetails theme={mockTheme} agent={beta} />);
		await act(async () => {
			resolve(auditFor('alpha'));
		});
		expect(screen.queryByTestId('proxy-audit-text')).not.toBeInTheDocument();
		expect(screen.getByTestId('proxy-audit-read')).toHaveTextContent('Audit Beta');
		footprint.mockResolvedValueOnce(auditFor('beta'));
		fireEvent.click(screen.getByTestId('proxy-audit-read'));
		await screen.findByTestId('proxy-audit-text');
		expect(footprint).toHaveBeenLastCalledWith('beta');
		expect(report).toHaveBeenCalledTimes(1);
	});

	it('rejects a response for a different agent', async () => {
		footprint.mockResolvedValueOnce(auditFor('beta'));
		render(<ProxyInspectionDetails theme={mockTheme} agent={alpha} />);
		await openDetails();
		fireEvent.click(screen.getByTestId('proxy-audit-read'));
		expect(await screen.findByRole('alert')).toHaveTextContent('different agent');
		expect(screen.queryByTestId('proxy-audit-text')).not.toBeInTheDocument();
	});

	it('opens the existing continuity modal for the exact currently selected AI tab', async () => {
		const tab = createMockAITab({ id: 'ai-one' });
		useSessionStore.setState({
			sessions: [createMockSession({ ...alpha, aiTabs: [tab], activeTabId: tab.id })],
			activeSessionId: alpha.id,
		});
		render(<ProxyInspectionDetails theme={mockTheme} agent={alpha} />);
		await openDetails();
		fireEvent.click(screen.getByTestId('proxy-continuity-preview'));
		expect(useModalStore.getState().getData('continuityPreview')).toEqual({
			sessionId: 'alpha',
			tabId: 'ai-one',
		});
		expect(footprint).not.toHaveBeenCalled();
	});

	it('disables continuity without an AI tab and hides inventory without an agent', async () => {
		render(<ProxyInspectionDetails theme={mockTheme} agent={null} />);
		await openDetails();
		expect(screen.getByTestId('proxy-continuity-preview')).toBeDisabled();
		expect(screen.queryByTestId('proxy-audit-read')).not.toBeInTheDocument();
	});

	it.each([
		{ selected: 'missing-tab', hidden: false },
		{ selected: 'other-tab', hidden: true },
	])(
		'requires an exact visible AI tab without substituting or exposing a hidden consult: %j',
		async ({ selected, hidden }) => {
			useSessionStore.setState({
				sessions: [
					createMockSession({
						...alpha,
						aiTabs: [createMockAITab({ id: 'other-tab', hidden })],
						activeTabId: selected,
					}),
				],
				activeSessionId: alpha.id,
			});
			render(<ProxyInspectionDetails theme={mockTheme} agent={alpha} />);
			await openDetails();
			expect(screen.getByTestId('proxy-continuity-preview')).toBeDisabled();
			expect(useModalStore.getState().isOpen('continuityPreview')).toBe(false);
		}
	);

	it.each([EMPTY_MODEL_USAGE, { ...currentProxyModelUsage(), proxy: EMPTY_MODEL_USAGE.proxy }])(
		'keeps inspection available with no recorded proxy usage',
		async (usage) => {
			getModelUsage.mockResolvedValue(usage);
			useSessionStore.setState({ sessions: [createMockSession(alpha)], activeSessionId: alpha.id });
			render(<ModelUsageStats theme={mockTheme} timeRange="week" />);
			await screen.findByTestId('proxy-inspection-details');
			expect(report).not.toHaveBeenCalled();
			await openDetails();
			expect(screen.getByTestId('proxy-audit-read')).toHaveTextContent('Audit Alpha');
			expect(getModelUsage).toHaveBeenCalledTimes(1);
		}
	);

	it('keeps independent inspection available when range statistics fail', async () => {
		getModelUsage.mockRejectedValueOnce(new Error('stats unavailable'));
		render(<ModelUsageStats theme={mockTheme} timeRange="week" />);
		await screen.findByTestId('model-usage-error');
		expect(report).not.toHaveBeenCalled();
		await openDetails();
		expect(report).toHaveBeenCalledTimes(1);
	});
});
