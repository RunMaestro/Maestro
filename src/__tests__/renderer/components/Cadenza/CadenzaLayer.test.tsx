import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CadenzaLayer } from '../../../../renderer/components/Cadenza/CadenzaLayer';
import { applyCadenzaPayload, useCadenzaStore } from '../../../../renderer/stores/cadenzaStore';
import { mockTheme } from '../../../helpers/mockTheme';

describe('CadenzaLayer', () => {
	beforeEach(() => {
		useCadenzaStore.setState({ cadenzas: [], flashedId: null });
		vi.mocked(window.maestro.fs.readFile).mockReset();
	});

	it('loads an image cadenza through the shared local-image IPC path', async () => {
		const path = 'C:\\workspace\\artifacts\\preview.png';
		const dataUrl = 'data:image/png;base64,cHJldmlldw==';
		vi.mocked(window.maestro.fs.readFile).mockResolvedValue(dataUrl);
		applyCadenzaPayload({
			op: 'open',
			id: 'preview',
			viewType: 'image',
			title: 'Build preview',
			path,
		});

		render(<CadenzaLayer theme={mockTheme} />);

		const image = await screen.findByRole('img', { name: 'Build preview' });
		expect(window.maestro.fs.readFile).toHaveBeenCalledWith(path, undefined);
		expect(image).toHaveAttribute('src', dataUrl);
		expect(image).toHaveAttribute('draggable', 'false');
	});

	it('labels plugin-namespaced host views with their provenance', () => {
		applyCadenzaPayload({
			op: 'open',
			id: 'com.acme.metrics/release-summary',
			viewType: 'view',
			title: 'Release summary',
			body: JSON.stringify({ blocks: [] }),
			sourcePlugin: 'Acme Metrics',
		});
		render(<CadenzaLayer theme={mockTheme} />);

		expect(screen.getByText('from Acme Metrics')).toHaveAttribute('title', 'from Acme Metrics');
	});
});
