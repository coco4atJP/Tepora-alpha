import type React from "react";
import { useEffect, useRef } from "react";

interface FitTextProps {
	children: React.ReactNode;
	className?: string;
	minFontSize?: number;
	maxFontSize?: number;
	step?: number;
}

export const FitText: React.FC<FitTextProps> = ({
	children,
	className = "",
	minFontSize = 10,
	maxFontSize = 100, // Will be limited by initial computed style usually
	step = 0.5,
}) => {
	const containerRef = useRef<HTMLDivElement>(null);
	const textRef = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		const container = containerRef.current;
		const text = textRef.current;

		if (!container || !text) return;

		const resizeText = () => {
			// Reset to 1 to get natural size
			text.style.fontSize = "";

			const containerWidth = container.offsetWidth;
			const containerHeight = container.offsetHeight;

			// If not constrained, do nothing (handling 0 size case)
			if (containerWidth === 0 || containerHeight === 0) return;

			let low = minFontSize;
			let high = maxFontSize;
			const safeStep = step > 0 ? step : 0.5;
			// Start with the computed font size as the initial guess/max
			const computedStyle = window.getComputedStyle(text);
			const initialFontSize = parseFloat(computedStyle.fontSize);

			if (Number.isFinite(initialFontSize) && initialFontSize > 0) {
				high = Math.min(high, initialFontSize);
			}

			let bestSize = low;

			// Simple binary search for best fit
			// Note: This modifies the DOM directly for measurement, which is expensive but effective for this specific requirement
			while (low <= high) {
				const mid = (low + high) / 2;
				text.style.fontSize = `${mid}px`;

				if (
					text.scrollWidth <= containerWidth &&
					text.scrollHeight <= containerHeight
				) {
					bestSize = mid;
					low = mid + safeStep;
				} else {
					high = mid - safeStep;
				}
			}

			text.style.fontSize = `${bestSize}px`;
		};

		// Observe container size changes if available; otherwise fall back to window resize.
		const observerSupported = typeof ResizeObserver !== "undefined";
		const observer = observerSupported ? new ResizeObserver(resizeText) : null;
		if (observer) observer.observe(container);
		if (!observer) window.addEventListener("resize", resizeText);

		// Initial call
		resizeText();

		return () => {
			if (observer) observer.disconnect();
			if (!observer) window.removeEventListener("resize", resizeText);
		};
	}, [minFontSize, maxFontSize, step]);

	return (
		<div
			ref={containerRef}
			className={`w-full h-full overflow-hidden ${className}`}
			style={{ display: "flex", alignItems: "center" }}
		>
			<span
				ref={textRef}
				style={{
					whiteSpace: "nowrap",
					overflow: "hidden",
					textOverflow: "ellipsis",
					display: "inline-block",
					maxWidth: "100%",
				}}
			>
				{children}
			</span>
		</div>
	);
};
