import { createRef } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageAttachInput, stageImageFiles } from '../../../../renderer/components/ChatComposer';
import { captureException } from '../../../../renderer/utils/sentry';

vi.mock('../../../../renderer/utils/sentry', () => ({ captureException: vi.fn() }));

type Outcome = { kind: 'load'; result: string } | { kind: 'error' } | { kind: 'abort' };

/**
 * A FileReader whose outcome the test decides, fired synchronously from
 * `readAsDataURL` so no timers are needed.
 */
let nextOutcomes: Outcome[] = [];
class FakeFileReader {
	error: DOMException | null = null;
	onload: ((event: { target: { result: string } }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onabort: ((event: { type: string }) => void) | null = null;
	readAsDataURL() {
		const outcome = nextOutcomes.shift() ?? { kind: 'load', result: 'data:image/png;base64,AA' };
		if (outcome.kind === 'load') this.onload?.({ target: { result: outcome.result } });
		else if (outcome.kind === 'error') {
			this.error = new DOMException('boom');
			this.onerror?.({ type: 'error' });
		} else this.onabort?.({ type: 'abort' });
	}
}

function file(name = 'shot.png', type = 'image/png', size = 4) {
	return new File(['x'.repeat(size)], name, { type });
}

/** A setStagedImages that applies each updater to a local array. */
function stagedState(initial: string[] = []) {
	let images = initial;
	const setStagedImages = vi.fn((update: string[] | ((prev: string[]) => string[])) => {
		images = typeof update === 'function' ? update(images) : update;
	});
	return {
		setStagedImages,
		get images() {
			return images;
		},
	};
}

describe('stageImageFiles', () => {
	beforeEach(() => {
		nextOutcomes = [];
		vi.stubGlobal('FileReader', FakeFileReader);
		vi.mocked(captureException).mockClear();
	});
	afterEach(() => vi.unstubAllGlobals());

	it('stages each file it reads, in order', () => {
		const state = stagedState();
		nextOutcomes = [
			{ kind: 'load', result: 'data:a' },
			{ kind: 'load', result: 'data:b' },
		];
		stageImageFiles([file('a.png'), file('b.png')], {
			setStagedImages: state.setStagedImages,
			reportComponent: 'Test',
		});

		expect(state.images).toEqual(['data:a', 'data:b']);
	});

	it('ignores a duplicate image and says so', () => {
		const state = stagedState(['data:a']);
		const flash = vi.fn();
		nextOutcomes = [{ kind: 'load', result: 'data:a' }];
		stageImageFiles([file()], {
			setStagedImages: state.setStagedImages,
			showFlashNotification: flash,
			reportComponent: 'Test',
		});

		expect(state.images).toEqual(['data:a']);
		expect(flash).toHaveBeenCalledWith('Duplicate image ignored');
	});

	it('reports and flashes a read error', () => {
		const state = stagedState();
		const flash = vi.fn();
		nextOutcomes = [{ kind: 'error' }];
		stageImageFiles([file('bad.png', 'image/png', 7)], {
			setStagedImages: state.setStagedImages,
			showFlashNotification: flash,
			reportComponent: 'GroupChatInput',
		});

		expect(state.setStagedImages).not.toHaveBeenCalled();
		expect(flash).toHaveBeenCalledWith('Failed to attach image');
		expect(captureException).toHaveBeenCalledWith(expect.any(DOMException), {
			extra: {
				component: 'GroupChatInput',
				action: 'attachImage.readError',
				fileName: 'bad.png',
				fileType: 'image/png',
				fileSize: 7,
			},
		});
	});

	it('reports and flashes an aborted read', () => {
		const flash = vi.fn();
		nextOutcomes = [{ kind: 'abort' }];
		stageImageFiles([file('gone.png')], {
			setStagedImages: vi.fn(),
			showFlashNotification: flash,
			reportComponent: 'InputArea.ToolbarControls',
		});

		expect(flash).toHaveBeenCalledWith('Image attachment canceled');
		expect(captureException).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'Image attachment read aborted' }),
			{
				extra: expect.objectContaining({
					component: 'InputArea.ToolbarControls',
					action: 'attachImage.readAbort',
					fileName: 'gone.png',
					eventType: 'abort',
				}),
			}
		);
	});

	it('refuses a file the surface check rejects, before reading it, and flashes why', () => {
		const state = stagedState();
		const flash = vi.fn();
		const readSpy = vi.spyOn(FakeFileReader.prototype, 'readAsDataURL');
		stageImageFiles([file('big.png'), file('ok.png')], {
			setStagedImages: state.setStagedImages,
			showFlashNotification: flash,
			reportComponent: 'Test',
			checkFile: (f) => (f.name === 'big.png' ? 'Image too large' : null),
		});

		expect(flash).toHaveBeenCalledWith('Image too large');
		expect(readSpy).toHaveBeenCalledTimes(1);
		expect(state.images).toEqual(['data:image/png;base64,AA']);
		readSpy.mockRestore();
	});
});

describe('ImageAttachInput', () => {
	beforeEach(() => vi.stubGlobal('FileReader', FakeFileReader));
	afterEach(() => vi.unstubAllGlobals());

	it('forwards its ref, stages the picked files, and clears the value for the next pick', () => {
		const ref = createRef<HTMLInputElement>();
		const state = stagedState();
		render(
			<ImageAttachInput
				ref={ref}
				id="attach"
				setStagedImages={state.setStagedImages}
				reportComponent="Test"
			/>
		);

		const input = ref.current!;
		expect(input.id).toBe('attach');
		expect(input.accept).toBe('image/*');
		expect(input.multiple).toBe(true);

		fireEvent.change(input, { target: { files: [file()] } });

		expect(state.images).toEqual(['data:image/png;base64,AA']);
		expect(input.value).toBe('');
	});
});
