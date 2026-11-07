/**
 * @file SecretScreenConfirmHost.test.tsx
 * @description The dialog every publishing path shows when the secret screen
 * refuses: the masked findings, "Publish anyway", and "Cancel".
 */

import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SecretScreenConfirmHost } from '../../../renderer/components/SecretScreenConfirmHost';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { confirmSecretFindings } from '../../../renderer/services/secretScreen';
import { useSecretScreenStore } from '../../../renderer/stores/secretScreenStore';
import { mockTheme } from '../../helpers/mockTheme';
import type { SecretFinding } from '../../../shared/secretScan';

const findings: SecretFinding[] = [
	{ kind: 'github-token', line: 12, preview: '••••••••abcd', source: 'logs.json' },
	{ kind: 'env-var-value', line: 3, preview: '••••••••aple', name: 'DB_PASSWORD' },
];

const renderHost = () =>
	render(
		<LayerStackProvider>
			<SecretScreenConfirmHost theme={mockTheme} />
		</LayerStackProvider>
	);

describe('SecretScreenConfirmHost', () => {
	beforeEach(() => {
		useSecretScreenStore.setState({ queue: [] });
	});

	it('renders nothing while no publish is waiting', () => {
		renderHost();
		expect(screen.queryByText('Possible Secrets Found')).not.toBeInTheDocument();
	});

	it('lists the masked findings and says nothing was sent', async () => {
		renderHost();
		void confirmSecretFindings(findings, { subject: 'this gist' });

		expect(await screen.findByText('Possible Secrets Found')).toBeInTheDocument();
		expect(
			screen.getByText('This gist contains 2 things that look like secrets. Nothing has been sent.')
		).toBeInTheDocument();
		const list = within(screen.getByTestId('secret-screen-findings'));
		expect(list.getByText('GitHub token ••••••••abcd (logs.json, line 12)')).toBeInTheDocument();
		expect(
			list.getByText('Configured secret DB_PASSWORD ••••••••aple (line 3)')
		).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Publish anyway' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
	});

	it('uses the singular for one finding', async () => {
		renderHost();
		void confirmSecretFindings(findings.slice(0, 1), { subject: 'this feedback' });
		expect(
			await screen.findByText(
				'This feedback contains what looks like a secret. Nothing has been sent.'
			)
		).toBeInTheDocument();
	});

	it('resolves true on "Publish anyway" and closes', async () => {
		renderHost();
		const answer = confirmSecretFindings(findings, { subject: 'this gist' });

		fireEvent.click(await screen.findByRole('button', { name: 'Publish anyway' }));

		await expect(answer).resolves.toBe(true);
		expect(screen.queryByText('Possible Secrets Found')).not.toBeInTheDocument();
	});

	it('resolves false on Cancel', async () => {
		renderHost();
		const answer = confirmSecretFindings(findings, { subject: 'this gist' });

		fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

		await expect(answer).resolves.toBe(false);
		expect(screen.queryByText('Possible Secrets Found')).not.toBeInTheDocument();
	});

	it("shows the caller's confirm label and the model note", async () => {
		renderHost();
		void confirmSecretFindings(findings, {
			subject: 'this support package',
			confirmLabel: 'Create anyway',
			note: 'Secret screen model did not run: Not installed. Pattern detection still ran.',
		});

		expect(await screen.findByRole('button', { name: 'Create anyway' })).toBeInTheDocument();
		expect(screen.getByText(/Secret screen model did not run/)).toBeInTheDocument();
	});

	it('draws the next request once the first is answered', async () => {
		renderHost();
		void confirmSecretFindings(findings, { subject: 'this gist' });
		void confirmSecretFindings(findings.slice(0, 1), { subject: 'this comment' });

		fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

		expect(
			await screen.findByText(
				'This comment contains what looks like a secret. Nothing has been sent.'
			)
		).toBeInTheDocument();
	});
});
