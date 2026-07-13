import '@testing-library/jest-dom';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

declare global {
	var maestroInteractivePanel: unknown;
}

afterEach(() => {
	document.body.innerHTML = '';
	delete globalThis.maestroInteractivePanel;
	vi.resetModules();
});

describe('OMP panel bootstrap', () => {
	it('renders a typed incompatible state when the frozen guest bridge is absent', async () => {
		document.body.innerHTML = '<div id="root"></div>';

		// Intentional dynamic import: this module has a browser bootstrap side effect.
		await import('../../../../plugins/com.maestro.omp/src/panel/index');

		expect(await screen.findByRole('alert')).toHaveTextContent(
			'Interactive panel bridge is unavailable'
		);
	});
});
