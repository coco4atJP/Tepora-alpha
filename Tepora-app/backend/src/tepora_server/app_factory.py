import asyncio
import logging
import sys
import os
import time
from typing import Callable, List
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pathlib import Path

from src.tepora_server.state import AppState
from src.tepora_server.api import ws, routes, setup, mcp_routes, sessions
from src.core.config import settings, PROJECT_ROOT

logger = logging.getLogger("tepora.server.factory")

# Default CORS origins for development are now handled in settings schema fallback
# Local logic removed in favor of settings.server.cors_origins


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize and cleanup the application."""
    logger.info("🚀 Tepora Web Server starting up...")
    try:
        # Load Config Explicitly
        from src.core.config.loader import config_manager
        config_manager.load_config()

        # Validate Config (Fail-Fast)
        from src.core.app.startup_validator import validate_startup_config
        
        # Run blocking validation in a thread to avoid blocking the event loop
        await asyncio.get_running_loop().run_in_executor(
            None, validate_startup_config, settings, PROJECT_ROOT
        )
        logger.info("✅ Startup configuration validated.")

        # Initialize Application State
        state = AppState()
        await state.initialize()
        app.state.app_state = state
        
        if not state.core.initialized:
            logger.critical("Failed to initialize core app components.")
            raise RuntimeError("Failed to initialize core app")
            
        logger.info("✅ Tepora Web Server ready!")
    except Exception as e:
        logger.critical(f"❌ Critical failure during startup: {e}", exc_info=True)
        raise
    
    yield
    
    logger.info("🔻 Tepora Web Server shutting down...")
    
    # Cleanup MCP resources
    if hasattr(app.state, 'app_state') and app.state.app_state:
        await app.state.app_state.shutdown()


def create_app() -> FastAPI:
    app = FastAPI(title="Tepora AI Agent", version="1.0.0", lifespan=lifespan)

    # CORS - Configurable origins
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.server.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Global Exception Handler (Audit Issue 3.3)
    from .api.exception_handlers import global_exception_handler
    app.add_exception_handler(Exception, global_exception_handler)

    # Request Logging Middleware
    @app.middleware("http")
    async def log_requests(request: Request, call_next: Callable):
        start_time = time.time()
        response = await call_next(request)
        process_time = (time.time() - start_time) * 1000
        logger.info(f"{request.method} {request.url.path} - {response.status_code} - {process_time:.2f}ms")
        return response

    # Include Routers
    app.include_router(routes.router)
    app.include_router(setup.router)  # Setup wizard API
    app.include_router(mcp_routes.router)  # MCP management API
    app.include_router(sessions.router)  # Session history API
    app.include_router(ws.router)

    # Serve Frontend (Static Files) - Legacy/Dev support
    # Only if dist exists.
    try:
        # Assuming we are in backend/src/tepora_server/app_factory.py
        # root is ../../../
        current_file = Path(__file__)
        project_root = current_file.parent.parent.parent.parent # src/tepora_server/app_factory.py -> backend -> project_root
        frontend_dist = project_root / "frontend" / "dist"

        if frontend_dist.exists():
            assets_path = frontend_dist / "assets"
            if assets_path.exists():
                app.mount("/assets", StaticFiles(directory=str(assets_path)), name="assets")

            @app.get("/{full_path:path}")
            async def serve_spa(full_path: str):
                # Check for API/WS prefixes to avoid capturing them (though router order usually handles this)
                if full_path.startswith("api") or full_path.startswith("ws"):
                     return JSONResponse(status_code=404, content={"error": "Not Found"})

                # File check
                file_path = frontend_dist / full_path
                if file_path.exists() and file_path.is_file():
                    return FileResponse(str(file_path))
                
                # SPA Fallback
                index_path = frontend_dist / "index.html"
                if index_path.exists():
                    return FileResponse(str(index_path))
                
                return JSONResponse(status_code=404, content={"error": "Not Found"})
    except Exception as e:
        logger.warning(f"Could not setup static file serving: {e}")

    return app
