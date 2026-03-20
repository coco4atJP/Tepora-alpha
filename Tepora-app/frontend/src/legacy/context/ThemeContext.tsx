import type React from "react";
import { createContext, useContext, useEffect, useState } from "react";

type Theme = "tepora" | "light" | "dark" | "system";

interface ThemeContextType {
	theme: Theme;
	setTheme: (theme: Theme) => void;
	activeTheme: "tepora" | "light" | "dark"; // The actual resolved theme
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
	const [theme, setTheme] = useState<Theme>(() => {
		const saved = localStorage.getItem("tepora-theme");
		return (saved as Theme) || "tepora"; // Default to Tepora if nothing saved
	});

	const [activeTheme, setActiveTheme] = useState<"tepora" | "light" | "dark">("tepora");

	useEffect(() => {
		localStorage.setItem("tepora-theme", theme);

		const updateActiveTheme = () => {
			if (theme === "system") {
				const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
				// If system is dark, we default to Tepora as the "Dark" experience for this app unless specified otherwise
				// But the plan said "Dark" -> Tepora. Let's stick to that.
				setActiveTheme(isDark ? "tepora" : "light");
			} else {
				setActiveTheme(theme);
			}
		};

		updateActiveTheme();

		const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
		const handler = () => {
			if (theme === "system") updateActiveTheme();
		};

		mediaQuery.addEventListener("change", handler);
		return () => mediaQuery.removeEventListener("change", handler);
	}, [theme]);

	useEffect(() => {
		const root = window.document.documentElement;
		root.setAttribute("data-theme", activeTheme);
		// Also set class for easy tailwind dark mode if needed, though we use data-theme
		if (activeTheme === "light") {
			root.classList.remove("dark");
			root.classList.add("light");
		} else {
			root.classList.remove("light");
			root.classList.add("dark");
		}
	}, [activeTheme]);

	return (
		<ThemeContext.Provider value={{ theme, setTheme, activeTheme }}>
			{children}
		</ThemeContext.Provider>
	);
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme() {
	const context = useContext(ThemeContext);
	if (context === undefined) {
		throw new Error("useTheme must be used within a ThemeProvider");
	}
	return context;
}
