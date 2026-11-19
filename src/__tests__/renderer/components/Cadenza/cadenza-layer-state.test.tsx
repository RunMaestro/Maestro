// Source: src/__tests__/renderer/components/Cadenza/CadenzaLayer.test.tsx
// Source: src/__tests__/renderer/stores/cadenzaStore.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { act } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { CadenzaLayer } from '../../../../renderer/components/Cadenza/CadenzaLayer';
import { applyCadenzaPayload } from '../../../../renderer/stores/cadenzaStore';
import { useCadenzaStore } from '../../../../renderer/stores/cadenzaStore';
import { mockTheme } from '../../../helpers/mockTheme';
import { afterEach } from 'vitest';
describeSourceSuite('CadenzaLayer', () => {
	describe('CadenzaLayer', () => {
		beforeEach(() => {
			useCadenzaStore.setState({ cadenzas: [], hidden: false, flashedId: null });
			vi.mocked(window.maestro.fs.readFile).mockReset();
			vi.mocked(window.maestro.process.releaseConcertoHtmlDocument).mockClear();
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

		it('stashes every card without unmounting it, so live state survives', () => {
			applyCadenzaPayload({
				op: 'open',
				id: 'game',
				viewType: 'html',
				title: 'Live game',
				body: '<button>Move</button>',
			});
			render(<CadenzaLayer theme={mockTheme} />);
			const frame = screen.getByTestId('concerto-html-iframe');

			act(() => useCadenzaStore.getState().setHidden(true));

			expect(screen.getByTestId('cadenza-layer')).toHaveStyle({ visibility: 'hidden' });
			expect(screen.getByTestId('concerto-html-iframe')).toBe(frame);

			act(() => useCadenzaStore.getState().setHidden(false));

			expect(screen.getByTestId('cadenza-layer')).toHaveStyle({ visibility: 'visible' });
			expect(screen.getByTestId('concerto-html-iframe')).toBe(frame);
		});

		it('leaves the stash alone when an agent opens another card', () => {
			useCadenzaStore.getState().setHidden(true);

			applyCadenzaPayload({ op: 'open', id: 'tracker', title: 'Tracker' });

			expect(useCadenzaStore.getState().hidden).toBe(true);
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

		it('renders an HTML cadenza in the isolated document frame', () => {
			applyCadenzaPayload({
				op: 'open',
				id: 'mini-mockup',
				viewType: 'html',
				title: 'Mini mockup',
				body: '<style>body{margin:0}</style><button>Try it</button>',
			});
			render(<CadenzaLayer theme={mockTheme} />);

			const iframe = screen.getByTestId('concerto-html-iframe');
			expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
			expect(iframe.getAttribute('src')).toContain(
				'maestro-concerto://render/?surface=cadenza&id=mini-mockup'
			);

			fireEvent.click(screen.getByRole('button', { name: 'Close cadenza' }));
			expect(window.maestro.process.releaseConcertoHtmlDocument).toHaveBeenCalledWith(
				'cadenza',
				'mini-mockup'
			);
			expect(useCadenzaStore.getState().cadenzas).toEqual([]);
		});
	});
});
describeSourceSuite('cadenzaStore', () => {
	function reset() {
		useCadenzaStore.setState({ cadenzas: [], flashedId: null });
	}

	describe('applyCadenzaPayload', () => {
		beforeEach(reset);

		it('open applies defaults (tracker type, theme color, id as title)', () => {
			applyCadenzaPayload({ op: 'open', id: 'tests' });
			const c = useCadenzaStore.getState().cadenzas[0];
			expect(c).toMatchObject({ id: 'tests', viewType: 'tracker', color: 'theme', title: 'tests' });
			expect(typeof c.x).toBe('number');
			expect(typeof c.y).toBe('number');
		});

		it('open honors explicit fields', () => {
			applyCadenzaPayload({
				op: 'open',
				id: 'c',
				viewType: 'decision',
				title: 'Ship it?',
				color: 'orange',
				options: [{ label: 'Yes', value: 'yes' }],
			});
			expect(useCadenzaStore.getState().cadenzas[0]).toMatchObject({
				viewType: 'decision',
				title: 'Ship it?',
				color: 'orange',
				options: [{ label: 'Yes', value: 'yes' }],
			});
		});

		it('update patches only the sent fields, leaving title intact on a body-only update', () => {
			applyCadenzaPayload({ op: 'open', id: 'c', title: 'Suite', body: 'running' });
			applyCadenzaPayload({ op: 'update', id: 'c', body: '3/10 passed' });
			expect(useCadenzaStore.getState().cadenzas[0]).toMatchObject({
				title: 'Suite',
				body: '3/10 passed',
			});
		});

		it('re-opening an existing id preserves its position', () => {
			applyCadenzaPayload({ op: 'open', id: 'c' });
			const { x, y } = useCadenzaStore.getState().cadenzas[0];
			applyCadenzaPayload({ op: 'open', id: 'c', title: 'renamed' });
			expect(useCadenzaStore.getState().cadenzas).toHaveLength(1);
			expect(useCadenzaStore.getState().cadenzas[0]).toMatchObject({ x, y, title: 'renamed' });
		});

		it('close removes the cadenza', () => {
			applyCadenzaPayload({ op: 'open', id: 'c' });
			applyCadenzaPayload({ op: 'close', id: 'c' });
			expect(useCadenzaStore.getState().cadenzas).toHaveLength(0);
		});

		it('keeps static plugin view data safe across update and close', () => {
			const id = 'com.acme.metrics/release-summary';
			applyCadenzaPayload({
				op: 'open',
				id,
				viewType: 'view',
				title: 'Release summary',
				body: JSON.stringify({ blocks: [{ kind: 'text', text: 'Initial report' }] }),
				sourcePlugin: 'Acme Metrics',
			});
			applyCadenzaPayload({
				op: 'update',
				id,
				body: JSON.stringify({ blocks: [{ kind: 'text', text: 'Updated report' }] }),
			});

			expect(useCadenzaStore.getState().cadenzas).toMatchObject([
				{
					id,
					viewType: 'view',
					title: 'Release summary',
					sourcePlugin: 'Acme Metrics',
					body: JSON.stringify({ blocks: [{ kind: 'text', text: 'Updated report' }] }),
				},
			]);

			applyCadenzaPayload({ op: 'close', id });
			expect(useCadenzaStore.getState().cadenzas).toHaveLength(0);
		});
	});

	describe('flashItem', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			reset();
		});
		afterEach(() => {
			vi.clearAllTimers();
			vi.useRealTimers();
		});

		it('pulses the id then clears it after the timeout', () => {
			useCadenzaStore.getState().flashItem('c');
			expect(useCadenzaStore.getState().flashedId).toBe('c');
			vi.advanceTimersByTime(2200);
			expect(useCadenzaStore.getState().flashedId).toBeNull();
		});
	});
});
