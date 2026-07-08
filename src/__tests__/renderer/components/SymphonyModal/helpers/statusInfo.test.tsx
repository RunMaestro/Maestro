/**
 * Tests for SymphonyModal/helpers/statusInfo - STATUS_COLORS palette + getStatusInfo
 * mapping for every known ContributionStatus.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { isValidElement } from 'react';
import type { ContributionStatus } from '../../../../../shared/symphony-types';

// Mock the Spinner so we can detect it without exercising real timers
vi.mock('../../../../../renderer/components/ui/Spinner', () => ({
	Spinner: ({ size }: { size?: number }) => <span data-testid="spinner" data-size={size} />,
}));

// Mock lucide-react so we can identify icons by name
vi.mock('lucide-react', () => {
	const icon = (name: string) => {
		const Component = () => <svg data-testid={`icon-${name}`} />;
		Component.displayName = name;
		return Component;
	};
	return {
		Play: icon('Play'),
		Pause: icon('Pause'),
		CheckCircle: icon('CheckCircle'),
		GitPullRequest: icon('GitPullRequest'),
		AlertCircle: icon('AlertCircle'),
		X: icon('X'),
	};
});

import {
	STATUS_COLORS,
	getStatusInfo,
} from '../../../../../renderer/components/SymphonyModal/helpers/statusInfo';

const KNOWN_STATUSES: { status: ContributionStatus; label: string; iconTestId: string }[] = [
	{ status: 'cloning', label: 'Cloning', iconTestId: 'spinner' },
	{ status: 'creating_pr', label: 'Creating PR', iconTestId: 'spinner' },
	{ status: 'running', label: 'Running', iconTestId: 'icon-Play' },
	{ status: 'paused', label: 'Paused', iconTestId: 'icon-Pause' },
	{ status: 'completed', label: 'Completed', iconTestId: 'icon-CheckCircle' },
	{ status: 'completing', label: 'Completing', iconTestId: 'spinner' },
	{ status: 'ready_for_review', label: 'Ready for Review', iconTestId: 'icon-GitPullRequest' },
	{ status: 'failed', label: 'Failed', iconTestId: 'icon-AlertCircle' },
	{ status: 'cancelled', label: 'Cancelled', iconTestId: 'icon-X' },
];

describe('SymphonyModal/helpers/statusInfo', () => {
	describe('STATUS_COLORS', () => {
		it('has a color entry for every known status', () => {
			for (const { status } of KNOWN_STATUSES) {
				expect(STATUS_COLORS[status]).toMatch(/^#[0-9A-Fa-f]{6}$/);
			}
		});
	});

	describe('getStatusInfo', () => {
		for (const { status, label, iconTestId } of KNOWN_STATUSES) {
			it(`maps ${status} → ${label} with correct icon`, () => {
				const info = getStatusInfo(status);
				expect(info.label).toBe(label);
				expect(info.color).toBe(STATUS_COLORS[status]);
				expect(isValidElement(info.icon)).toBe(true);

				const { getByTestId } = render(<>{info.icon}</>);
				expect(getByTestId(iconTestId)).toBeTruthy();
			});
		}

		it('falls back for unknown persisted statuses', () => {
			const info = getStatusInfo('reviewing');
			expect(info.label).toBe('reviewing');
			expect(info.color).toBe(STATUS_COLORS.paused);
			expect(isValidElement(info.icon)).toBe(true);

			const { getByTestId } = render(<>{info.icon}</>);
			expect(getByTestId('icon-AlertCircle')).toBeTruthy();
		});
	});
});
