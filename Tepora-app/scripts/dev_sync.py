#!/usr/bin/env python3
"""
Development Server with Dynamic Port Synchronization

This script starts the backend server first, captures its dynamically
assigned port from stdout, then starts the frontend dev server with
the correct VITE_API_PORT environment variable.

Usage:
    python scripts/dev_sync.py
    
Or via Taskfile:
    task dev-sync
"""

import os
import re
import subprocess
import sys
import signal
import threading
from pathlib import Path

# Project paths
SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
BACKEND_DIR = PROJECT_ROOT / "backend"
FRONTEND_DIR = PROJECT_ROOT / "frontend"

# Regex to capture port from backend output
PORT_PATTERN = re.compile(r"TEPORA_PORT=(\d+)")

# Process handles for cleanup
backend_process = None
frontend_process = None


def stream_output(process, prefix: str, port_callback=None):
    """Stream process output line by line with optional port capture."""
    captured_port = None
    
    for line in iter(process.stdout.readline, ''):
        if not line:
            break
        
        line = line.rstrip()
        
        # Check for port announcement
        if port_callback and not captured_port:
            match = PORT_PATTERN.search(line)
            if match:
                captured_port = int(match.group(1))
                port_callback(captured_port)
        
        # Print with prefix
        print(f"[{prefix}] {line}", flush=True)
    
    # Also stream stderr
    for line in iter(process.stderr.readline, ''):
        if not line:
            break
        print(f"[{prefix}] {line.rstrip()}", flush=True)


def cleanup_processes(signum=None, frame=None):
    """Terminate all child processes."""
    global backend_process, frontend_process
    
    print("\n[dev-sync] Shutting down...", flush=True)
    
    if frontend_process and frontend_process.poll() is None:
        print("[dev-sync] Stopping frontend...", flush=True)
        frontend_process.terminate()
        try:
            frontend_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            frontend_process.kill()
    
    if backend_process and backend_process.poll() is None:
        print("[dev-sync] Stopping backend...", flush=True)
        backend_process.terminate()
        try:
            backend_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            backend_process.kill()
    
    print("[dev-sync] Shutdown complete.", flush=True)
    sys.exit(0)


def main():
    global backend_process, frontend_process
    
    # Register signal handlers for graceful shutdown
    signal.signal(signal.SIGINT, cleanup_processes)
    signal.signal(signal.SIGTERM, cleanup_processes)
    
    # Windows-specific: handle Ctrl+C properly
    if sys.platform == "win32":
        signal.signal(signal.SIGBREAK, cleanup_processes)
    
    print("[dev-sync] Starting backend server (dynamic port)...", flush=True)
    
    # Event to signal when port is captured
    port_captured = threading.Event()
    captured_port = [None]  # Use list to allow modification in nested function
    
    def on_port_captured(port: int):
        captured_port[0] = port
        port_captured.set()
        print(f"[dev-sync] Backend port captured: {port}", flush=True)
    
    # Start backend without PORT env (let it pick dynamically)
    backend_env = os.environ.copy()
    backend_env.pop("PORT", None)  # Ensure dynamic allocation
    
    backend_process = subprocess.Popen(
        [sys.executable, "server.py"],
        cwd=str(BACKEND_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        env=backend_env,
    )
    
    # Start backend output streaming in background thread
    backend_thread = threading.Thread(
        target=stream_output,
        args=(backend_process, "backend", on_port_captured),
        daemon=True
    )
    backend_thread.start()
    
    # Wait for port to be captured (with timeout)
    print("[dev-sync] Waiting for backend to announce port...", flush=True)
    if not port_captured.wait(timeout=30):
        print("[dev-sync] ERROR: Timeout waiting for backend port!", flush=True)
        cleanup_processes()
        return
    
    port = captured_port[0]
    
    # Small delay to ensure backend is fully ready
    import time
    time.sleep(1)
    
    print(f"[dev-sync] Starting frontend with VITE_API_PORT={port}...", flush=True)
    
    # Start frontend with captured port
    frontend_env = os.environ.copy()
    frontend_env["VITE_API_PORT"] = str(port)
    
    # Use npm on Windows, npm on Unix
    npm_cmd = "npm.cmd" if sys.platform == "win32" else "npm"
    
    frontend_process = subprocess.Popen(
        [npm_cmd, "run", "dev"],
        cwd=str(FRONTEND_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        env=frontend_env,
    )
    
    # Start frontend output streaming in background thread
    frontend_thread = threading.Thread(
        target=stream_output,
        args=(frontend_process, "frontend"),
        daemon=True
    )
    frontend_thread.start()
    
    print(f"[dev-sync] Development servers running:", flush=True)
    print(f"           Backend:  http://localhost:{port}", flush=True)
    print(f"           Frontend: http://localhost:5173", flush=True)
    print(f"           Press Ctrl+C to stop", flush=True)
    
    # Wait for either process to exit
    try:
        while True:
            if backend_process.poll() is not None:
                print("[dev-sync] Backend process exited!", flush=True)
                break
            if frontend_process.poll() is not None:
                print("[dev-sync] Frontend process exited!", flush=True)
                break
            
            import time
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        cleanup_processes()


if __name__ == "__main__":
    main()
