import type React from "react";

const DynamicBackground: React.FC = () => {
	// Replaced the heavy canvas animation with a static return.
	// The visuals are now handled purely by the static CSS gradients in Layout.tsx
	// This drastically reduces the GPU/CPU load caused by repainting Gaussian blurs at 30+ FPS.
	return null;
};

export default DynamicBackground;
