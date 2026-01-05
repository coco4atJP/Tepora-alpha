import type React from "react";
import { useEffect, useRef } from "react";

const DynamicBackground: React.FC = () => {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;

		const ctx = canvas.getContext("2d", { alpha: false }); // Optimize for no transparency on canvas itself if possible, but we use alpha.
		// Actually, let's keep default context but just be careful.
		if (!ctx) return;

		let animationFrameId: number;
		let width = window.innerWidth;
		let height = window.innerHeight;

		const resize = () => {
			width = window.innerWidth;
			height = window.innerHeight;
			canvas.width = width;
			canvas.height = height;
		};

		window.addEventListener("resize", resize);
		resize();

		// --- Configuration ---
		// Slightly increased counts for better visuals, keeping FPS limit
		const STEAM_COUNT = 12;
		const PARTICLE_COUNT = 35;
		const FPS = 30;
		const INTERVAL = 1000 / FPS;

		// --- Types ---
		interface Steam {
			x: number;
			y: number;
			vx: number;
			vy: number;
			radius: number;
			opacity: number;
			life: number;
			maxLife: number;
		}

		interface Particle {
			x: number;
			y: number;
			vx: number;
			vy: number;
			size: number;
			color: string;
			baseOpacity: number; // Store base opacity
			phase: number; // For twinkling
			phaseSpeed: number; // Speed of twinkle
		}

		// --- Initialization ---
		const steamParticles: Steam[] = [];
		const cyberParticles: Particle[] = [];

		const initSteam = (): Steam => ({
			x: Math.random() * width,
			y: height + Math.random() * 200,
			vx: (Math.random() - 0.5) * 0.5,
			vy: -0.2 - Math.random() * 0.5,
			radius: 50 + Math.random() * 100,
			opacity: 0,
			life: 0,
			maxLife: 300 + Math.random() * 300,
		});

		const initParticle = (): Particle => ({
			x: Math.random() * width,
			y: Math.random() * height,
			vx: (Math.random() - 0.5) * 0.3, // Slightly faster
			vy: (Math.random() - 0.5) * 0.3,
			size: Math.random() * 3 + 1, // Slightly larger to show gradient
			color: Math.random() > 0.7 ? "#00f0ff" : "#ffd700", // Cyan or Gold
			baseOpacity: Math.random() * 0.5 + 0.3,
			phase: Math.random() * Math.PI * 2,
			phaseSpeed: 0.05 + Math.random() * 0.05,
		});

		for (let i = 0; i < STEAM_COUNT; i++) {
			steamParticles.push(initSteam());
		}

		for (let i = 0; i < PARTICLE_COUNT; i++) {
			cyberParticles.push(initParticle());
		}

		// --- Animation Loop ---
		let lastTime = 0;

		const render = (currentTime: number) => {
			animationFrameId = requestAnimationFrame(render);

			const delta = currentTime - lastTime;
			if (delta < INTERVAL) return;

			// Adjust lastTime to target FPS interval
			lastTime = currentTime - (delta % INTERVAL);

			ctx.clearRect(0, 0, width, height);

			// Background Gradient (Deep Tea - slightly richer)
			const gradient = ctx.createLinearGradient(0, 0, width, height);
			gradient.addColorStop(0, "#0a0402"); // Deep Warm Black
			gradient.addColorStop(0.5, "#120805"); // Mid Warmth
			gradient.addColorStop(1, "#1f0d08"); // Dark Tea base
			ctx.fillStyle = gradient;
			ctx.fillRect(0, 0, width, height);

			// Draw Steam
			ctx.globalCompositeOperation = "screen";
			steamParticles.forEach((p, i) => {
				p.x += p.vx;
				p.y += p.vy;
				p.life++;

				// Fade in/out
				if (p.life < 100) {
					p.opacity = (p.life / 100) * 0.15;
				} else if (p.life > p.maxLife - 100) {
					p.opacity = ((p.maxLife - p.life) / 100) * 0.15;
				}

				// Reset
				if (p.life >= p.maxLife) {
					steamParticles[i] = initSteam();
				}

				// Draw Cloud
				const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius);
				grad.addColorStop(0, `rgba(219, 89, 37, ${p.opacity})`); // Tea Orange
				grad.addColorStop(1, "rgba(0,0,0,0)");

				ctx.fillStyle = grad;
				ctx.beginPath();
				ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
				ctx.fill();
			});

			// Draw Cyber Particles with Gradient Glow (Simulated Bloom)
			ctx.globalCompositeOperation = "screen"; // additive
			cyberParticles.forEach((p) => {
				p.x += p.vx;
				p.y += p.vy;

				// Update animation phase
				p.phase += p.phaseSpeed;
				const twinkle = Math.sin(p.phase) * 0.3 + 0.7; // vary between 0.4 and 1.0 roughly
				const currentOpacity = p.baseOpacity * twinkle;

				// Bounce off edges
				if (p.x < 0 || p.x > width) p.vx *= -1;
				if (p.y < 0 || p.y > height) p.vy *= -1;

				// Draw with efficient gradient glow
				// Create a radial gradient for each particle to mimic a glow
				const glowRadius = p.size * 4; // Glow extends beyond the physical size
				const grad = ctx.createRadialGradient(
					p.x,
					p.y,
					0,
					p.x,
					p.y,
					glowRadius,
				);

				// Parse color to add opacity
				// Assuming hex colors #RRGGBB
				const r = parseInt(p.color.slice(1, 3), 16);
				const g = parseInt(p.color.slice(3, 5), 16);
				const b = parseInt(p.color.slice(5, 7), 16);

				grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${currentOpacity})`); // Core
				grad.addColorStop(
					0.4,
					`rgba(${r}, ${g}, ${b}, ${currentOpacity * 0.4})`,
				); // Mid glow
				grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`); // Fade out

				ctx.fillStyle = grad;
				ctx.beginPath();
				ctx.arc(p.x, p.y, glowRadius, 0, Math.PI * 2);
				ctx.fill();
			});
			ctx.globalAlpha = 1;
		};

		animationFrameId = requestAnimationFrame(render);

		return () => {
			window.removeEventListener("resize", resize);
			cancelAnimationFrame(animationFrameId);
		};
	}, []);

	return (
		<canvas
			ref={canvasRef}
			className="fixed inset-0 w-full h-full pointer-events-none -z-10"
		/>
	);
};

export default DynamicBackground;
