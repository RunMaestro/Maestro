/** @type {import('tailwindcss').Config} */
export default {
	content: ['./src/renderer/**/*.{js,ts,jsx,tsx}', './src/web/**/*.{js,ts,jsx,tsx}'],
	theme: {
		extend: {
			fontFamily: {
				mono: ['"JetBrains Mono"', '"Fira Code"', '"Courier New"', 'monospace'],
			},
			// Semantic color tokens bound to runtime theme CSS custom properties.
			// Values resolve via `--maestro-*` variables written by
			// `src/web/utils/cssCustomProperties.ts`, so Tailwind utilities
			// (e.g. `bg-background`, `text-text-main`) react to live theme swaps.
			// Every entry here corresponds 1:1 to a token in
			// `colorToCSSProperty` (cssCustomProperties.ts). When adding a new
			// theme color there, add its Tailwind token below too.
			colors: {
				'bg-main': 'var(--maestro-bg-main)',
				'bg-sidebar': 'var(--maestro-bg-sidebar)',
				'bg-activity': 'var(--maestro-bg-activity)',
				border: 'var(--maestro-border)',
				'text-main': 'var(--maestro-text-main)',
				'text-dim': 'var(--maestro-text-dim)',
				accent: 'var(--maestro-accent)',
				'accent-dim': 'var(--maestro-accent-dim)',
				'accent-text': 'var(--maestro-accent-text)',
				'accent-foreground': 'var(--maestro-accent-foreground)',
				success: 'var(--maestro-success)',
				warning: 'var(--maestro-warning)',
				error: 'var(--maestro-error)',
				// Alias so `bg-background` reads naturally for the main canvas.
				background: 'var(--maestro-bg-main)',
				// Non-theme color: the "connecting" badge state is an orange flag
				// that doesn't participate in user-selectable themes. Defined as
				// a literal hex so Tailwind's opacity modifiers (e.g.
				// `bg-connecting/[0.125]`) work — they don't with `var(...)` tokens.
				connecting: '#f97316',
			},
			// Card-specific elevation shadow. Preserves the exact legacy
			// `box-shadow` value from `Card.tsx`'s `elevated` variant — Tailwind's
			// stock `shadow-md` is close but differs in the second layer offset
			// (-2px vs -1px) and opacity (0.1 vs 0.06).
			boxShadow: {
				'card-elevated':
					'0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
			},
		},
	},
	plugins: [],
};
