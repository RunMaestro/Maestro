import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
	SteeredMessageHeader,
	SteerTurnConnector,
	steerBubbleCopy,
} from '../../../renderer/components/SteeredMessageHeader';
import { mockTheme } from '../../helpers/mockTheme';

// The global lucide mock renders each icon as an svg carrying this test id.
const CHECK = '[data-testid="check-icon"]';

describe('SteeredMessageHeader', () => {
	it('shows a spinner and no check while the verdict is outstanding', () => {
		render(<SteeredMessageHeader state="pending" theme={mockTheme} />);

		const header = screen.getByTestId('steered-message-header');
		expect(header).toHaveAttribute('data-steer-state', 'pending');
		expect(header).toHaveTextContent('Steering the running turn');
		expect(screen.getByTestId('steered-message-spinner')).toBeInTheDocument();
		expect(header.querySelector(CHECK)).toBeNull();
	});

	it('gives the check only to a steer the running turn absorbed', () => {
		render(<SteeredMessageHeader state="absorbed" theme={mockTheme} />);

		const header = screen.getByTestId('steered-message-header');
		expect(header).toHaveTextContent('Steered into the running turn');
		expect(header.querySelector(CHECK)).not.toBeNull();
		expect(screen.queryByTestId('steered-message-spinner')).not.toBeInTheDocument();
	});

	it('mutes a steer taken as a follow-up and claims no success', () => {
		const { unmount } = render(<SteeredMessageHeader state="absorbed" theme={mockTheme} />);
		const steerColor = screen.getByTestId('steered-message-header').style.color;
		unmount();

		render(<SteeredMessageHeader state="queued" theme={mockTheme} />);

		const header = screen.getByTestId('steered-message-header');
		expect(header).toHaveTextContent('Sent as a follow-up');
		// The verdict lands when the follow-up turn starts, before any reply exists.
		expect(header.textContent).not.toMatch(/answered/i);
		expect(header.title).not.toMatch(/answered/i);
		expect(header.querySelector(CHECK)).toBeNull();
		// Not the Steer accent: it did not steer anything.
		expect(header.style.color).not.toBe(steerColor);
	});

	it('claims no outcome for a steer recorded before the state existed', () => {
		render(<SteeredMessageHeader state={undefined} theme={mockTheme} />);

		const header = screen.getByTestId('steered-message-header');
		expect(header).toHaveAttribute('data-steer-state', 'unrecorded');
		expect(header).toHaveTextContent('Steered');
		expect(header).toHaveAttribute(
			'title',
			'Sent as a steer into the turn that was already running'
		);
		expect(header.querySelector(CHECK)).toBeNull();
	});

	it('names the turns that took a group chat steer', () => {
		render(<SteeredMessageHeader state={undefined} theme={mockTheme} targets={['Alice', 'Bob']} />);

		const header = screen.getByTestId('steered-message-header');
		expect(header).toHaveTextContent('Steered to Alice, Bob');
		expect(header).toHaveAttribute(
			'title',
			'Typed into the round that was already running. Taken by: Alice, Bob.'
		);
	});

	it('falls back to the state copy for an empty target list', () => {
		render(<SteeredMessageHeader state="absorbed" theme={mockTheme} targets={[]} />);

		const header = screen.getByTestId('steered-message-header');
		expect(header).toHaveTextContent('Steered into the running turn');
		expect(header.textContent).not.toMatch(/Steered to/);
	});

	it('has distinct copy for every state', () => {
		const labels = (['pending', 'absorbed', 'queued', undefined] as const).map(
			(state) => steerBubbleCopy(state).label
		);
		expect(new Set(labels).size).toBe(labels.length);
	});
});

describe('SteerTurnConnector', () => {
	it('ends in one elbow when nothing below it is stitched to the turn', () => {
		render(<SteerTurnConnector theme={mockTheme} mirrored={false} continues={false} />);

		const connector = screen.getByTestId('steer-turn-connector');
		expect(connector.children).toHaveLength(1);
		expect(connector.children[0].className).toContain('border-l');
	});

	it('draws a junction that runs on when the next entry is stitched too', () => {
		render(<SteerTurnConnector theme={mockTheme} mirrored={false} continues />);

		expect(screen.getByTestId('steer-turn-connector').children).toHaveLength(2);
	});

	it('hangs off the other side when the bubble is on the left', () => {
		render(<SteerTurnConnector theme={mockTheme} mirrored continues={false} />);

		const connector = screen.getByTestId('steer-turn-connector');
		expect(connector.className).toContain('-ml-4');
		expect(connector.children[0].className).toContain('border-r');
	});

	it('is hidden from assistive tech and on a phone', () => {
		render(<SteerTurnConnector theme={mockTheme} mirrored={false} continues={false} />);

		const connector = screen.getByTestId('steer-turn-connector');
		expect(connector).toHaveAttribute('aria-hidden', 'true');
		expect(connector.className).toContain('hidden sm:block');
	});
});
