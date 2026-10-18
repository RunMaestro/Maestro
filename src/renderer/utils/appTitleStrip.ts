import { isWebDesktop } from './runtimeContext';

/**
 * Height of the custom title strip `AppShell` draws (its `pt-10`) when the
 * native title bar is off. The strip is `-webkit-app-region: drag`, which means
 * the OS eats every mouse event over it, so anything floating at the top of the
 * window (the media player) has to stay below it.
 */
export const APP_TITLE_STRIP_HEIGHT = 40;

export interface AppTitleStripConditions {
	isMobileLandscape: boolean;
	useNativeTitleBar: boolean;
	isMdDownViewport: boolean;
	/** Override for tests; defaults to the live `isWebDesktop()` answer. */
	isWebDesktop?: boolean;
}

/**
 * Whether the custom title strip is on screen. The ONE definition: the shell
 * that draws the strip and every surface that has to keep clear of it ask this,
 * so they cannot disagree about where the drag region is. A copy that forgot
 * the md-down viewport and web-desktop conditions kept the media player 40px
 * clear of a strip that was not drawn.
 */
export function shouldShowAppTitleStrip(conditions: AppTitleStripConditions): boolean {
	const webDesktop = conditions.isWebDesktop ?? isWebDesktop();
	return (
		!conditions.isMobileLandscape &&
		!conditions.useNativeTitleBar &&
		!conditions.isMdDownViewport &&
		!webDesktop
	);
}
