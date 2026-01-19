/**
 * why-did-you-render setup for development performance profiling
 *
 * This file is only loaded in development mode via Vite's alias configuration.
 * In production, the empty wdyr.ts is used instead.
 *
 * To track a specific component, add this to the component file:
 *   MyComponent.whyDidYouRender = true;
 *
 * Or track all pure components by setting trackAllPureComponents: true below.
 *
 * Output appears in the browser DevTools console showing:
 * - Which components re-rendered
 * - What props/state changes triggered the re-render
 * - Whether the re-render was necessary
 */
import React from 'react';

// Use dynamic import for ESM compatibility with Vite
import('@welldone-software/why-did-you-render')
	.then((whyDidYouRenderModule) => {
		const whyDidYouRender = whyDidYouRenderModule.default;

		whyDidYouRender(React, {
			// Track all pure components (React.memo, PureComponent)
			// Set to true to see ALL unnecessary re-renders
			trackAllPureComponents: true,

			// Track React hooks like useMemo, useCallback
			trackHooks: true,

			// Log to console (can also use custom notifier)
			logOnDifferentValues: true,

			// Collapse logs by default (expand to see details)
			collapseGroups: true,

			// Include component stack traces
			include: [
				// Add specific components to always track, e.g.:
				// /^RightPanel/,
				// /^AutoRun/,
				// /^FilePreview/,
			],

			// Exclude noisy components you don't care about
			exclude: [/^BrowserRouter/, /^Link/, /^Route/],
		});
	})
	.catch((err) => {
		console.warn('[wdyr] Failed to load why-did-you-render:', err);
	});
