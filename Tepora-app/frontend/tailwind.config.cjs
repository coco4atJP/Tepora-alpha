/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            fontFamily: {
                sans: ['Outfit', 'sans-serif'],
                display: ['Cinzel', 'serif'],
                mono: ['JetBrains Mono', 'monospace'],
            },
            colors: {
                primary: {
                    50: '#fef2f2',
                    100: '#fee2e2',
                    200: '#fecaca',
                    300: '#fca5a5',
                    400: '#f87171',
                    500: '#ef4444',
                    600: '#dc2626',
                    700: '#b91c1c',
                    800: '#991b1b',
                    900: '#7f1d1d',
                },
                coffee: {
                    50: '#fdf8f6',
                    100: '#f2e8e5',
                    200: '#eaddd7',
                    300: '#e0cec7',
                    400: '#d2bab0',
                    500: '#a77f71',
                    600: '#8a5a4c',
                    700: '#6f453a',
                    800: '#57362e',
                    900: '#3d2620',
                },
                gold: {
                    100: '#fbf8cc',
                    200: '#f7f199',
                    300: '#f3ea66',
                    400: '#f0e333',
                    500: '#d4c820',
                    600: '#aa9f10',
                    700: '#80770c',
                    800: '#555008',
                    900: '#2b2804',
                },
                gemini: {
                    start: '#4b3f35', // Deep Coffee
                    mid: '#8a5a4c',   // Medium Coffee
                    end: '#d4af37',   // Gold
                    accent: '#00ffcc', // Neon Cyan (Near Future)
                }
            },
            animation: {
                'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                'float': 'float 6s ease-in-out infinite',
                'gradient-x': 'gradient-x 15s ease infinite',
            },
            keyframes: {
                float: {
                    '0%, 100%': { transform: 'translateY(0)' },
                    '50%': { transform: 'translateY(-10px)' },
                },
                'gradient-x': {
                    '0%, 100%': {
                        'background-size': '200% 200%',
                        'background-position': 'left center'
                    },
                    '50%': {
                        'background-size': '200% 200%',
                        'background-position': 'right center'
                    },
                },
            },
        },
    },
    plugins: [],
}
