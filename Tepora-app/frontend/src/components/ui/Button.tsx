import { Loader2 } from "lucide-react";
import React from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "icon" | "danger";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: ButtonVariant;
	size?: ButtonSize;
	isLoading?: boolean;
	icon?: React.ReactNode;
	children?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	(
		{
			className = "",
			variant = "primary",
			size = "md",
			isLoading = false,
			icon,
			children,
			disabled,
			...props
		},
		ref,
	) => {
		// Base styles optimized for GPU (transform)
		const baseStyles =
			"relative inline-flex items-center justify-center font-medium transition-all duration-300 active:scale-95 disabled:pointer-events-none disabled:opacity-50 overflow-hidden font-sans tracking-wide";

		const variants: Record<ButtonVariant, string> = {
			primary:
				"bg-gradient-to-br from-gold-400 to-tea-600 text-white shadow-[0_4px_14px_0_rgba(189,75,38,0.39)] hover:shadow-[0_6px_20px_rgba(219,89,37,0.23)] hover:brightness-110 border border-white/10",
			secondary:
				"glass-button text-theme-text border-theme-border hover:bg-theme-overlay hover:border-text-accent backdrop-blur-md",
			ghost: "bg-transparent text-theme-subtext hover:text-theme-text hover:bg-white/5",
			icon: "p-0 bg-transparent text-theme-subtext hover:text-theme-text hover:bg-white/5 rounded-full aspect-square",
			danger:
				"bg-semantic-error/10 text-semantic-error border border-semantic-error/30 hover:bg-semantic-error hover:text-white shadow-lg shadow-semantic-error/10",
		};

		const sizes: Record<ButtonSize, string> = {
			sm: "h-8 px-3 text-xs rounded-lg gap-1.5",
			md: "h-10 px-4 py-2 text-sm rounded-xl gap-2",
			lg: "h-12 px-6 text-base rounded-2xl gap-2.5",
			icon: "h-10 w-10 p-2 rounded-full",
		};

		// Glow effect only for primary
		const glowEffect =
			variant === "primary" ? (
				<span className="absolute inset-0 w-full h-full bg-gradient-to-br from-transparent via-white/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none animate-shimmer" />
			) : null;

		return (
			<button
				ref={ref}
				className={`${baseStyles} ${variants[variant]} ${sizes[size]} ${className} group`}
				disabled={disabled || isLoading}
				{...props}
			>
				{glowEffect}

				{isLoading ? (
					<Loader2 className="w-4 h-4 animate-spin" />
				) : (
					<>
						{icon && <span className="shrink-0">{icon}</span>}
						{children}
					</>
				)}
			</button>
		);
	},
);

Button.displayName = "Button";
