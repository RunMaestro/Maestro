/**
 * @file CenterFlash.test.tsx
 * @description How the Center Flash draws its detail line: a path or id stays on
 * one truncated monospace line, a prose sentence (wrapDetail) wraps so it can be read.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { CenterFlash } from '../../../renderer/components/CenterFlash';
import { notifyCenterFlash, dismissCenterFlash } from '../../../renderer/stores/centerFlashStore';
import { mockTheme } from '../../helpers/mockTheme';

describe('CenterFlash detail line', () => {
	afterEach(() => {
		act(() => dismissCenterFlash());
	});

	it('truncates a detail to one monospace line by default', () => {
		act(() => {
			notifyCenterFlash({ message: 'Copied', detail: '/a/very/long/path.ts', duration: 0 });
		});
		render(<CenterFlash theme={mockTheme} />);

		const detail = screen.getByText('/a/very/long/path.ts');
		expect(detail.className).toContain('truncate');
		expect(detail.className).toContain('font-mono');
		expect(detail.getAttribute('title')).toBe('/a/very/long/path.ts');
	});

	it('wraps a prose detail when wrapDetail is set', () => {
		const sentence =
			'More than one agent is working. @mention the one agent to steer, or the message sends when the round ends.';
		act(() => {
			notifyCenterFlash({
				message: 'Could not steer this round',
				detail: sentence,
				wrapDetail: true,
				duration: 0,
			});
		});
		render(<CenterFlash theme={mockTheme} />);

		const detail = screen.getByText(sentence);
		expect(detail.className).toContain('break-words');
		expect(detail.className).not.toContain('truncate');
		expect(detail.className).not.toContain('font-mono');
		expect(detail.hasAttribute('title')).toBe(false);
	});
});
