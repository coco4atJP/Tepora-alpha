import React, { useRef, useEffect } from 'react';

const DynamicBackground: React.FC = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
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

        window.addEventListener('resize', resize);
        resize();

        // --- Configuration ---
        const STEAM_COUNT = 15;
        const PARTICLE_COUNT = 40;

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
            opacity: number;
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
            vx: (Math.random() - 0.5) * 0.2,
            vy: (Math.random() - 0.5) * 0.2,
            size: Math.random() * 2 + 0.5,
            color: Math.random() > 0.8 ? '#00f0ff' : '#d4c820', // Cyan or Gold
            opacity: Math.random() * 0.5 + 0.2,
        });

        for (let i = 0; i < STEAM_COUNT; i++) {
            steamParticles.push(initSteam());
        }

        for (let i = 0; i < PARTICLE_COUNT; i++) {
            cyberParticles.push(initParticle());
        }

        // --- Animation Loop ---
        const render = () => {
            ctx.clearRect(0, 0, width, height);

            // Background Gradient (Deep Tea)
            const gradient = ctx.createLinearGradient(0, 0, width, height);
            gradient.addColorStop(0, '#050201'); // Black/Tea
            gradient.addColorStop(1, '#1a0b06'); // Dark Tea
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, width, height);

            // Draw Steam
            ctx.globalCompositeOperation = 'screen';
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
                grad.addColorStop(1, 'rgba(0,0,0,0)');

                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
                ctx.fill();
            });

            // Draw Cyber Particles
            ctx.globalCompositeOperation = 'screen'; // additive
            cyberParticles.forEach((p) => {
                p.x += p.vx;
                p.y += p.vy;

                // Bounce off edges
                if (p.x < 0 || p.x > width) p.vx *= -1;
                if (p.y < 0 || p.y > height) p.vy *= -1;

                // Draw
                ctx.fillStyle = p.color;
                ctx.globalAlpha = p.opacity;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                ctx.fill();

                // Glow
                ctx.shadowBlur = 10;
                ctx.shadowColor = p.color;
                ctx.fill();
                ctx.shadowBlur = 0;
            });
            ctx.globalAlpha = 1;

            animationFrameId = requestAnimationFrame(render);
        };

        render();

        return () => {
            window.removeEventListener('resize', resize);
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
