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
		},
	},
	plugins: [],
};
