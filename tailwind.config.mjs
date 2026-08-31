/** @type {import('tailwindcss').Config} */
export default {
	content: ['./src/renderer/**/*.{js,ts,jsx,tsx}', './src/web/**/*.{js,ts,jsx,tsx}'],
	theme: {
		extend: {
			fontFamily: {
				// `font-mono` marks the ~200 places that want a CODE face - shortcut
				// chips, hashes, paths, inline code - regardless of which surface
				// they sit on. As a hard-coded stack none of them followed the
				// user's chosen monospace font; as a variable they all do at once.
				//
				// The fallback lives INSIDE var(). A bare `var(--x)` followed by
				// comma-separated literals does not degrade to them: an undefined
				// custom property makes the whole declaration invalid at
				// computed-value time, so the literals never get a chance.
				mono: ['var(--maestro-font-mono, "JetBrains Mono", "Fira Code", "Courier New", monospace)'],
			},
		},
	},
	plugins: [],
};
