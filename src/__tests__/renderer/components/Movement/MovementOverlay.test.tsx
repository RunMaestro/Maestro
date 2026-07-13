import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MovementOverlay } from '../../../../renderer/components/Movement/MovementOverlay';
import { applyMovementPayload, useMovementStore } from '../../../../renderer/stores/movementStore';
import { mockTheme } from '../../../helpers/mockTheme';

describe('MovementOverlay', () => {
	beforeEach(() => {
		useMovementStore.setState({
			items: [],
			viewportWidth: 0,
			viewportHeight: 0,
			hidden: false,
			flashedId: null,
		});
	});

	it('labels plugin-namespaced host views with their provenance', () => {
		applyMovementPayload({
			op: 'add',
			id: 'com.acme.metrics/release-summary',
			title: 'Release summary',
			body: JSON.stringify({ blocks: [] }),
			sourcePlugin: 'Acme Metrics',
		});

		render(<MovementOverlay theme={mockTheme} />);

		expect(screen.getByText('from Acme Metrics')).toHaveAttribute('title', 'from Acme Metrics');
	});
});
