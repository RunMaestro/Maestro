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
import whyDidYouRender from '@welldone-software/why-did-you-render';

// Must run synchronously before any component renders so that React hooks
// are patched consistently from the very first render. Async loading (dynamic
// import) causes hooks to be patched mid-session, changing the hook count
// between renders and crashing libraries that use internal React hooks
// (e.g. Zustand v5's useCallback inside useStore).
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

	// Exclude noisy components you don't care about.
	// React Flow internals (MiniMap, NodeRenderer, NodeWrapper, MiniMapNodes)
	// subscribe to the RF store and re-render on every viewport/nodes change
	// by design — they swamp the console with unfixable noise. App-side
	// ReactFlow children should still be tracked normally.
	exclude: [
		/^BrowserRouter/,
		/^Link/,
		/^Route/,
		/^MiniMap$/,
		/^MiniMapNodes$/,
		/^NodeRenderer$/,
		/^NodeWrapper$/,
	],
});
