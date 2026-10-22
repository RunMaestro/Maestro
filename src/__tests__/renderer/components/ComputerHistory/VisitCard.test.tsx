import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VisitCard } from '../../../../renderer/components/ComputerHistory/VisitCard';
import {
	clockLabel,
	type Visit,
} from '../../../../renderer/components/ComputerHistory/timelineModel';
import type { StoredEvent } from '../../../../shared/computer-history/types';
import { mockTheme } from '../../../helpers/mockTheme';

const ts = '2026-10-10T23:36:14.250Z';
const textedit = { id: 'com.apple.TextEdit', name: 'TextEdit', pid: 501 };

const typed: StoredEvent = {
	v: 1,
	ts,
	kind: 'text.committed',
	app: textedit,
	window: { title: 'Untitled.txt' },
	element: { role: 'text_area' },
	text: 'Quarterly invoice draft',
	reason: 'idle',
	seq: 0,
};

const visit: Visit = {
	key: 'v1',
	appId: textedit.id,
	appName: textedit.name,
	title: 'Untitled.txt',
	startMs: Date.parse(ts),
	endMs: Date.parse(ts),
	rows: [typed],
	eventCount: 1,
};

describe('VisitCard', () => {
	it('renders the app, window title and the typed text', () => {
		render(<VisitCard theme={mockTheme} visit={visit} color="#5b8def" highlight="" />);

		expect(screen.getByText('TextEdit')).toBeTruthy();
		expect(screen.getByText('Untitled.txt')).toBeTruthy();
		expect(screen.getByText('Quarterly invoice draft')).toBeTruthy();
	});

	it("keeps a row's time on one line instead of pinning it to a fixed width", () => {
		// A 12-hour locale renders "06:36 PM", wider than the old 44px column,
		// so the meridiem wrapped under the time on every row.
		const { container } = render(
			<VisitCard theme={mockTheme} visit={visit} color="#5b8def" highlight="" />
		);

		const row = container.querySelector('li[data-kind="text.committed"]');
		const time = row?.querySelector('span');
		expect(time?.textContent).toBe(clockLabel(Date.parse(ts)));
		expect(time?.className).toContain('whitespace-nowrap');
		expect(time?.className).not.toMatch(/(^|\s)w-\d/);
	});
});
