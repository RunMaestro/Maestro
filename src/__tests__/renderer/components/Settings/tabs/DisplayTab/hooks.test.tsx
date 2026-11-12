import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	useBionifyAlgorithmState,
	useFontConfigurationState,
} from '../../../../../../renderer/components/Settings/tabs/DisplayTab/hooks';
import { DEFAULT_BIONIFY_ALGORITHM } from '../../../../../../renderer/utils/bionifyReadingMode';
import { logger } from '../../../../../../renderer/utils/logger';

describe('DisplayTab hooks', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		window.maestro.fonts = {
			detect: vi.fn().mockResolvedValue(['Menlo', 'Monaco', 'JetBrains Mono']),
		};
		window.maestro.settings.get = vi.fn().mockResolvedValue(undefined);
		window.maestro.settings.set = vi.fn().mockResolvedValue(undefined);
	});

	describe('useFontConfigurationState', () => {
		it('loads detected fonts lazily and only once', async () => {
			const { result } = renderHook(() => useFontConfigurationState());

			act(() => {
				result.current.handleFontInteraction();
			});

			await waitFor(() => expect(result.current.fontsLoaded).toBe(true));
			expect(result.current.systemFonts).toEqual(['Menlo', 'Monaco', 'JetBrains Mono']);
			expect(window.maestro.fonts.detect).toHaveBeenCalledTimes(1);

			act(() => {
				result.current.handleFontInteraction();
			});

			expect(window.maestro.fonts.detect).toHaveBeenCalledTimes(1);
		});

		it('loads saved custom fonts on mount without waiting for a dropdown click', async () => {
			vi.mocked(window.maestro.settings.get).mockResolvedValue(['Iosevka', 'Recursive Mono']);
			const { result } = renderHook(() => useFontConfigurationState());

			await waitFor(() =>
				expect(result.current.customFonts).toEqual(['Iosevka', 'Recursive Mono'])
			);
			expect(window.maestro.settings.get).toHaveBeenCalledWith('customFonts');
			// The expensive system sweep stays lazy; only the saved list is eager.
			expect(window.maestro.fonts.detect).not.toHaveBeenCalled();
		});

		it('keeps a font added before the saved list resolves', async () => {
			let resolveSaved: (value: string[]) => void = () => {};
			vi.mocked(window.maestro.settings.get).mockReturnValue(
				new Promise<string[]>((resolve) => {
					resolveSaved = resolve;
				})
			);
			const { result } = renderHook(() => useFontConfigurationState());

			act(() => {
				result.current.addCustomFont('Berkeley Mono');
			});
			act(() => {
				resolveSaved(['Iosevka']);
			});

			await waitFor(() =>
				expect(window.maestro.settings.set).toHaveBeenCalledWith('customFonts', ['Berkeley Mono'])
			);
			expect(result.current.customFonts).toEqual(['Berkeley Mono']);
		});

		it('adds and removes custom fonts while persisting the customFonts setting', () => {
			const { result } = renderHook(() => useFontConfigurationState());

			act(() => {
				result.current.addCustomFont('Iosevka');
			});

			expect(result.current.customFonts).toEqual(['Iosevka']);
			expect(window.maestro.settings.set).toHaveBeenLastCalledWith('customFonts', ['Iosevka']);

			act(() => {
				result.current.removeCustomFont('Iosevka');
			});

			expect(result.current.customFonts).toEqual([]);
			expect(window.maestro.settings.set).toHaveBeenLastCalledWith('customFonts', []);
		});

		it('ignores duplicate and empty custom font additions', () => {
			const { result } = renderHook(() => useFontConfigurationState());

			act(() => {
				result.current.addCustomFont('Iosevka');
			});
			act(() => {
				result.current.addCustomFont('Iosevka');
				result.current.addCustomFont('');
			});

			expect(result.current.customFonts).toEqual(['Iosevka']);
			expect(window.maestro.settings.set).toHaveBeenCalledTimes(1);
		});

		it('degrades to an unreliable list rather than an error when detection fails', async () => {
			// On stock macOS and Windows there is no fontconfig, so a failed
			// enumeration is the EXPECTED path. Reporting it as an error would
			// cry wolf on the majority platform; instead the result is flagged
			// unreliable and the picker suppresses availability annotations.
			vi.mocked(window.maestro.fonts.detect).mockRejectedValue(new Error('font scan failed'));
			const loggerSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
			const { result } = renderHook(() => useFontConfigurationState());

			act(() => {
				result.current.handleFontInteraction();
			});

			await waitFor(() => expect(result.current.fontLoading).toBe(false));
			expect(result.current.fontsLoaded).toBe(true);
			expect(result.current.fontsReliable).toBe(false);
			expect(result.current.systemFonts.length).toBeGreaterThan(0);
			expect(loggerSpy).not.toHaveBeenCalled();

			loggerSpy.mockRestore();
		});

		it('reports a successful enumeration as reliable', async () => {
			const { result } = renderHook(() => useFontConfigurationState());

			act(() => {
				result.current.handleFontInteraction();
			});

			await waitFor(() => expect(result.current.fontsLoaded).toBe(true));
			expect(result.current.fontsReliable).toBe(true);
		});
	});

	describe('useBionifyAlgorithmState', () => {
		it('starts with the saved algorithm or the default fallback', () => {
			const saved = renderHook(() =>
				useBionifyAlgorithmState({
					bionifyAlgorithm: '+ 1 1 2 2 0.5',
					setBionifyAlgorithm: vi.fn(),
				})
			);
			expect(saved.result.current.algorithmDraft).toBe('+ 1 1 2 2 0.5');

			const fallback = renderHook(() =>
				useBionifyAlgorithmState({
					bionifyAlgorithm: undefined,
					setBionifyAlgorithm: vi.fn(),
				})
			);
			expect(fallback.result.current.algorithmDraft).toBe(DEFAULT_BIONIFY_ALGORITHM);
		});

		it('syncs the draft when the saved algorithm changes after mount', async () => {
			const { result, rerender } = renderHook(
				({ algorithm }: { algorithm: string | undefined }) =>
					useBionifyAlgorithmState({
						bionifyAlgorithm: algorithm,
						setBionifyAlgorithm: vi.fn(),
					}),
				{ initialProps: { algorithm: '- 0 1 1 2 0.4' } }
			);

			act(() => {
				result.current.setAlgorithmDraft('- 0 1 1');
			});
			expect(result.current.algorithmDraft).toBe('- 0 1 1');

			rerender({ algorithm: '+ 1 1 2 2 0.55' });
			await waitFor(() => expect(result.current.algorithmDraft).toBe('+ 1 1 2 2 0.55'));

			rerender({ algorithm: undefined });
			await waitFor(() => expect(result.current.algorithmDraft).toBe(DEFAULT_BIONIFY_ALGORITHM));
		});

		it('commits a trimmed valid draft and skips unchanged values', () => {
			const setBionifyAlgorithm = vi.fn();
			const { result } = renderHook(() =>
				useBionifyAlgorithmState({
					bionifyAlgorithm: '- 0 1 1 2 0.4',
					setBionifyAlgorithm,
				})
			);

			act(() => {
				result.current.setAlgorithmDraft('  + 1 1 2 2 0.55  ');
			});
			act(() => {
				result.current.commitAlgorithmDraft();
			});

			expect(setBionifyAlgorithm).toHaveBeenCalledWith('+ 1 1 2 2 0.55');

			setBionifyAlgorithm.mockClear();
			act(() => {
				result.current.setAlgorithmDraft('- 0 1 1 2 0.4');
			});
			act(() => {
				result.current.commitAlgorithmDraft();
			});

			expect(setBionifyAlgorithm).not.toHaveBeenCalled();
		});

		it('does not commit invalid drafts', () => {
			const setBionifyAlgorithm = vi.fn();
			const { result } = renderHook(() =>
				useBionifyAlgorithmState({
					bionifyAlgorithm: '- 0 1 1 2 0.4',
					setBionifyAlgorithm,
				})
			);

			act(() => {
				result.current.setAlgorithmDraft('- 0 1 1');
			});
			act(() => {
				result.current.commitAlgorithmDraft();
			});

			expect(result.current.isAlgorithmValid).toBe(false);
			expect(setBionifyAlgorithm).not.toHaveBeenCalled();
		});

		it('opens and closes the Bionify info modal state', () => {
			const { result } = renderHook(() =>
				useBionifyAlgorithmState({
					bionifyAlgorithm: '- 0 1 1 2 0.4',
					setBionifyAlgorithm: vi.fn(),
				})
			);

			act(() => {
				result.current.openInfoModal();
			});
			expect(result.current.showInfoModal).toBe(true);

			act(() => {
				result.current.closeInfoModal();
			});
			expect(result.current.showInfoModal).toBe(false);
		});
	});
});
