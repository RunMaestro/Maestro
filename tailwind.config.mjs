/** @type {import('tailwindcss').Config} */
export default {
	content: ['./src/renderer/**/*.{js,ts,jsx,tsx}', './src/web/**/*.{js,ts,jsx,tsx}'],
	theme: {
		extend: {
			fontFamily: {
				mono: ['"JetBrains Mono"', '"Fira Code"', '"Courier New"', 'monospace'],
			},
			fontSize: {
				'3xs': '0.643rem', // 9px at 14px root
				'2xs': '0.714rem', // 10px at 14px root
				'xs-plus': '0.786rem', // 11px at 14px root
			},
			// Alias tokens: collapse corner-radius drift onto the two tiers the app
			// actually uses (4px and 8px) without editing a single call site.
			// rounded-full, rounded-2xl, and rounded-sm stay at their Tailwind defaults
			// because those are deliberate, distinct tiers.
			borderRadius: {
				md: '0.25rem', // was 6px - now identical to `rounded` (4px)
				xl: '0.5rem', // was 12px - now identical to `rounded-lg` (8px)
			},
			// Alias tokens: normalize the stray micro-variants onto the 150ms default.
			// duration-300 and duration-500 stay as-is - those are intentional tiers.
			transitionDuration: {
				100: '150ms',
				200: '150ms',
			},
		},
	},
	plugins: [],
};
