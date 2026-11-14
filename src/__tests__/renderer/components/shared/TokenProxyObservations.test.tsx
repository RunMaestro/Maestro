/**
 * Tests for TokenProxyObservations and ProxyReportLines: the one view of what the
 * token proxy observed since the app started (the originals read back and the
 * read opportunities), shared by the Gateway card in Settings and the Models
 * record. It is observation only and fetches nothing, so these cases pin what it
 * says, what it leaves out when a desktop did not send a part, and that a
 * preview opens to its facts without any read.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { ProxyReportLines } from '../../../../renderer/components/shared/ProxyReportLines';
import { TokenProxyObservations } from '../../../../renderer/components/shared/TokenProxyObservations';
import { TOKEN_PROXY_OPPORTUNITY_NOTE } from '../../../../shared/local-models/token-proxy';
import { TOKEN_PROXY_RECOVERY_HEADING } from '../../../../shared/local-models/token-proxy-report';
import { mockTheme } from '../../../helpers/mockTheme';
import { readOpportunities, recoveryObservations } from '../../../helpers/proxyTelemetryFixtures';

describe('ProxyReportLines', () => {
	it('lays each line out as a label and what it says, in order', () => {
		render(
			<ProxyReportLines
				testId="lines"
				lines={[
					{ label: 'Requests', text: '12 requests carried' },
					{ label: 'Skipped', text: '1 a body past the read limit' },
				]}
			/>
		);

		const list = screen.getByTestId('lines');
		expect(list.tagName).toBe('DL');
		expect(
			within(list)
				.getAllByRole('term')
				.map((el) => el.textContent)
		).toEqual(['Requests', 'Skipped']);
		expect(
			within(list)
				.getAllByRole('definition')
				.map((el) => el.textContent)
		).toEqual(['12 requests carried', '1 a body past the read limit']);
	});

	it('draws a list with no line as an empty list', () => {
		render(<ProxyReportLines lines={[]} testId="none" />);

		expect(screen.getByTestId('none').children).toHaveLength(0);
	});
});

describe('TokenProxyObservations', () => {
	it('says the originals read back and the read opportunities, each in its own section', () => {
		render(
			<TokenProxyObservations
				theme={mockTheme}
				recovery={recoveryObservations({
					mcpRetrieveTool: { invocations: 1, recoveredOriginals: 1 },
				})}
				opportunities={readOpportunities()}
			/>
		);

		expect(screen.getByTestId('token-proxy-recovery')).toHaveTextContent(
			TOKEN_PROXY_RECOVERY_HEADING
		);
		expect(screen.getByTestId('token-proxy-recovery-lines')).toHaveTextContent(
			'Retrieve tool1 call: 1 returned original text'
		);
		expect(screen.getByTestId('token-proxy-opportunities')).toHaveTextContent(
			'observation only, none of it was applied'
		);
		expect(screen.getByTestId('token-proxy-opportunity-note')).toHaveTextContent(
			TOKEN_PROXY_OPPORTUNITY_NOTE
		);
		expect(screen.queryByTestId('token-proxy-observations-none')).not.toBeInTheDocument();
	});

	it('shows only the part it was given, and says so when it was given neither', () => {
		const view = render(
			<TokenProxyObservations theme={mockTheme} opportunities={readOpportunities()} />
		);
		expect(screen.queryByTestId('token-proxy-recovery')).not.toBeInTheDocument();
		expect(screen.getByTestId('token-proxy-opportunities')).toBeInTheDocument();

		view.rerender(<TokenProxyObservations theme={mockTheme} recovery={recoveryObservations()} />);
		expect(screen.getByTestId('token-proxy-recovery')).toBeInTheDocument();
		expect(screen.queryByTestId('token-proxy-opportunities')).not.toBeInTheDocument();

		view.rerender(<TokenProxyObservations theme={mockTheme} />);
		expect(screen.getByTestId('token-proxy-observations-none')).toHaveTextContent(
			'This desktop sent no observations.'
		);
		expect(screen.queryByTestId('token-proxy-observations')).not.toBeInTheDocument();
	});

	it('names an agent by its id when the surface supplies no name, and by the surface name when it does', () => {
		const base = readOpportunities();
		const [first] = base.recent;
		const opportunities = {
			...base,
			recent: [first, { ...first, agentId: null, callId: 'toolu_03' }],
		};
		const view = render(<TokenProxyObservations theme={mockTheme} opportunities={opportunities} />);

		const [named, unnamed] = screen.getAllByTestId('token-proxy-opportunity');
		expect(named).toHaveTextContent('Agent agent-1');
		expect(unnamed).toHaveTextContent('No agent (started outside the app)');

		view.rerender(
			<TokenProxyObservations
				theme={mockTheme}
				opportunities={opportunities}
				nameOf={(id) => (id === null ? 'Nobody' : 'Alpha')}
			/>
		);
		const [alpha, nobody] = screen.getAllByTestId('token-proxy-opportunity');
		expect(alpha).toHaveTextContent('Alpha');
		expect(nobody).toHaveTextContent('Nobody');
	});

	it('opens a preview to its facts and closes it again, with the controlled region named only while open', () => {
		render(<TokenProxyObservations theme={mockTheme} opportunities={readOpportunities()} />);
		const toggle = screen.getByTestId('token-proxy-opportunity-toggle');

		expect(toggle).toHaveAttribute('aria-expanded', 'false');
		expect(toggle).not.toHaveAttribute('aria-controls');
		expect(toggle).toHaveTextContent('Show preview');

		fireEvent.click(toggle);

		const detail = screen.getByTestId('token-proxy-opportunity-detail');
		expect(toggle).toHaveAttribute('aria-expanded', 'true');
		expect(toggle).toHaveAttribute('aria-controls', detail.id);
		expect(toggle).toHaveTextContent('Hide preview');
		expect(detail).toHaveTextContent('File/work/app/src/a.ts');
		expect(detail).toHaveTextContent('Compared withthe read of call toolu_01');

		fireEvent.click(toggle);
		expect(screen.queryByTestId('token-proxy-opportunity-detail')).not.toBeInTheDocument();
	});

	it('names a preview kind this build does not know as it was stored', () => {
		const base = readOpportunities();
		render(
			<TokenProxyObservations
				theme={mockTheme}
				opportunities={{
					...base,
					recent: [{ ...base.recent[0], kind: 'future-kind' as never }],
				}}
			/>
		);

		expect(screen.getByTestId('token-proxy-opportunity')).toHaveTextContent('future-kind');
		expect(screen.getByTestId('token-proxy-opportunity')).toHaveAttribute(
			'data-kind',
			'future-kind'
		);
	});

	it('keeps an opened preview open when the same report arrives with a new tally', () => {
		const base = readOpportunities();
		const view = render(<TokenProxyObservations theme={mockTheme} opportunities={base} />);
		fireEvent.click(screen.getByTestId('token-proxy-opportunity-toggle'));

		view.rerender(
			<TokenProxyObservations
				theme={mockTheme}
				opportunities={{ ...base, coverage: { ...base.coverage, observed: 500 } }}
			/>
		);

		expect(screen.getByTestId('token-proxy-opportunity-detail')).toBeInTheDocument();
		expect(screen.getByTestId('token-proxy-opportunity-lines')).toHaveTextContent(
			'500 requests examined'
		);
	});

	it('reads nothing: it has no use for the app bridge', () => {
		const calls = vi.spyOn(window.maestro.localModels.proxy, 'report');
		render(
			<TokenProxyObservations
				theme={mockTheme}
				recovery={recoveryObservations()}
				opportunities={readOpportunities()}
			/>
		);
		fireEvent.click(screen.getByTestId('token-proxy-opportunity-toggle'));

		expect(calls).not.toHaveBeenCalled();
		calls.mockRestore();
	});
});
