import type React from "react";
import { useMemo } from "react";

interface SkeletonLoaderProps {
	className?: string;
	count?: number;
	variant?: "text" | "circular" | "rectangular" | "bubble";
}

export const SkeletonLoader: React.FC<SkeletonLoaderProps> = ({
	className = "",
	count = 1,
	variant = "text",
}) => {
	const loaderIds = useMemo(
		() =>
			Array.from({ length: count }, (_, index) => `skeleton-${variant}-${index}`),
		[count, variant],
	);

	const getVariantClasses = () => {
		switch (variant) {
			case "circular":
				return "rounded-full";
			case "rectangular":
				return "rounded-md";
			case "bubble":
				return "rounded-2xl rounded-tl-sm";
			default:
				return "rounded";
		}
	};

	return (
		<div className={`space-y-2 ${className} animate-fade-in`}>
			{loaderIds.map((id, index) => (
				<div
					key={id}
					className={`
            relative overflow-hidden bg-white/5 
            ${getVariantClasses()}
            ${variant === "text" ? "h-4 w-full" : "h-full w-full"}
            before:absolute before:inset-0
            before:-translate-x-full
            before:animate-[shimmer_2s_infinite]
            before:bg-gradient-to-r
            before:from-transparent before:via-white/5 before:to-transparent
          `}
					style={{
						animationDelay: `${index * 150}ms`,
					}}
				/>
			))}
		</div>
	);
};
