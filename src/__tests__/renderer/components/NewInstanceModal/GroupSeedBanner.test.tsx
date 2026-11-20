/**
 * @fileoverview Tests for GroupSeedBanner: the line above the New Agent tabs
 * that says the form was pre-filled from a group's defaults.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	GroupSeedBanner,
	type GroupSeedBannerProps,
} from '../../../../renderer/components/NewInstanceModal/GroupSeedBanner';
import type { Theme } from '../../../../renderer/types';

const createTheme = (): Theme =>
	({
		id: 'test-dark',
		name: 'Test Dark',
		mode: 'dark',
		colors: {
			bgMain: '#1a1a2e',
			bgSidebar: '#16213e',
			bgActivity: '#0f3460',
			textMain: '#e8e8e8',
			textDim: '#888888',
			accent: '#7b2cbf',
			accentDim: '#5a1f8f',
			accentForeground: '#ffffff',
			border: '#333355',
			success: '#22c55e',
			warning: '#f59e0b',
			error: '#ef4444',
			info: '#3b82f6',
			bgAccentHover: '#9333ea',
		},
	}) as Theme;

const renderBanner = (props: Partial<GroupSeedBannerProps> = {}) => {
	const onOpenGroupSettings = vi.fn();
	render(
		<GroupSeedBanner
			theme={createTheme()}
			group={{ name: 'Backend', emoji: '📦' }}
			sshRemoteMissing={false}
			appliedOnCreate={[]}
			skipped={[]}
			onOpenGroupSettings={onOpenGroupSettings}
			{...props}
		/>
	);
	return { onOpenGroupSettings, banner: screen.getByTestId('new-agent-group-seed-banner') };
};

describe('GroupSeedBanner', () => {
	it('says where the values came from, and nothing else for a plain seed', () => {
		const { banner } = renderBanner();

		expect(banner).toHaveTextContent(
			'Pre-filled from 📦 Backend group settings. Edit anything before creating.'
		);
		expect(screen.queryByTestId('new-agent-group-seed-ssh-note')).not.toBeInTheDocument();
		expect(screen.queryByTestId('new-agent-group-seed-extras')).not.toBeInTheDocument();
		expect(screen.queryByTestId('new-agent-group-seed-skipped')).not.toBeInTheDocument();
	});

	it('makes the group name the way into Group Settings', () => {
		const { onOpenGroupSettings } = renderBanner();

		fireEvent.click(screen.getByRole('button', { name: '📦 Backend' }));

		expect(onOpenGroupSettings).toHaveBeenCalledTimes(1);
	});

	it('draws a group with no emoji without a leading space', () => {
		renderBanner({ group: { name: 'Backend', emoji: '' } });
		expect(screen.getByRole('button', { name: 'Backend' })).toBeInTheDocument();
	});

	it('says so when the SSH remote of the defaults no longer exists', () => {
		const { banner } = renderBanner({ sshRemoteMissing: true });

		expect(screen.getByTestId('new-agent-group-seed-ssh-note')).toHaveTextContent(
			'SSH remote no longer exists, running locally.'
		);
		// Appended to the same line.
		expect(banner.querySelector('p')).toHaveTextContent(
			'Edit anything before creating. SSH remote no longer exists, running locally.'
		);
	});

	it('names the defaults that are set when the agent is created', () => {
		renderBanner({ appliedOnCreate: ['Tier Targets', 'System One'] });

		expect(screen.getByTestId('new-agent-group-seed-extras')).toHaveTextContent(
			'Also set when the agent is created: Tier Targets, System One. Change them afterwards in Edit Agent.'
		);
	});

	it('gives each default that was left out its own line, with the reason', () => {
		renderBanner({
			skipped: [
				{ label: 'Run On', reason: 'The remote cannot reach it.' },
				{ label: 'Tier: low', reason: 'The remote cannot reach it either.' },
			],
		});

		expect(
			screen.getAllByTestId('new-agent-group-seed-skipped').map((line) => line.textContent)
		).toEqual([
			'Not pre-filled: Run On. The remote cannot reach it.',
			'Not pre-filled: Tier: low. The remote cannot reach it either.',
		]);
	});
});
