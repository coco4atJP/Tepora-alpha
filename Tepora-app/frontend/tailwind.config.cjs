/** @type {import('tailwindcss').Config} */
module.exports = {
	content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
	theme: {
		extend: {
			fontFamily: {
				sans: [
					"Outfit",
					"Microsoft YaHei",
					"SimHei",
					"WenQuanYi Micro Hei",
					"PingFang SC",
					"Noto Sans SC",
					"Yu Gothic",
					"Meiryo",
					"sans-serif",
				],
				display: ["Cinzel", "serif"],
				mono: ["JetBrains Mono", "monospace"],
			},
			colors: {
				primary: {
					50: "#fef2f2",
					100: "#fee2e2",
					200: "#fecaca",
					300: "#fca5a5",
					400: "#f87171",
					500: "#ef4444",
					600: "#dc2626",
					700: "#b91c1c",
					800: "#991b1b",
					900: "#7f1d1d",
				},
				tea: {
					50: "#fdf6f3",
					100: "#fae8e0",
					200: "#f5d0bf",
					300: "#edab91",
					400: "#e47f5d",
					500: "#bd4b26",
					600: "#96351b",
					700: "#7a2715",
					800: "#632114",
					900: "#521d13",
					950: "#2e1510",
				},
				gold: {
					100: "#fcf8f0",
					200: "#f6efde",
					300: "#efe4c4",
					400: "#e6d5a3",
					500: "#d4bf80",
					600: "#aa9555",
					700: "#806e3b",
					800: "#5c4f2b",
					900: "#3d341d",
				},
				cyber: {
					cyan: "#00f0ff",
					magenta: "#ff0055",
				},
				tepora: {
					start: "#2e1510", // Deep Assam
					mid: "#bd4b26", // Amber Liquid
					end: "#f0e2c8", // Steam & Cream
					accent: "#4fffc0", // Cyber Leaf
				},
				// Semantic Theme Colors
				theme: {
					bg: "var(--bg-app)",
					panel: "var(--bg-panel)",
					overlay: "var(--bg-overlay)",
					text: "var(--text-primary)",
					subtext: "var(--text-secondary)",
					accent: "var(--text-accent)",
					border: "var(--border-subtle)",
					"border-highlight": "var(--border-highlight)",
					glass: "var(--glass-bg)",
					"glass-border": "var(--glass-border)",
					"glass-highlight": "var(--glass-highlight)",
				},
			},
			animation: {
				"pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
				float: "float 6s ease-in-out infinite",
				"gradient-x": "gradient-x 15s ease infinite",
			},
			keyframes: {
				float: {
					"0%, 100%": { transform: "translateY(0)" },
					"50%": { transform: "translateY(-10px)" },
				},
				"gradient-x": {
					"0%, 100%": {
						"background-size": "200% 200%",
						"background-position": "left center",
					},
					"50%": {
						"background-size": "200% 200%",
						"background-position": "right center",
					},
				},
			},
		},
	},
	plugins: [require("@tailwindcss/typography")],
};
