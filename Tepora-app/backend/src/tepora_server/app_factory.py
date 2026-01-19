import asyncio
import logging
import time
from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from src.core.common.security import SecurityUtils
from src.core.config import PROJECT_ROOT, settings
from src.tepora_server.api import mcp_routes, routes, sessions, setup, ws
from src.tepora_server.state import AppState

logger = logging.getLogger("tepora.server.factory")

# Default CORS origins for development are now handled in settings schema fallback
# Local logic removed in favor of settings.server.cors_origins


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize and cleanup the application."""
    logger.info("Tepora Web Server starting up...")
    try:
        # Load Config Explicitly
        from src.core.config.loader import config_manager

        config_manager.load_config()

        # Initialize Session Token for API/WebSocket Authentication
        from src.tepora_server.api.security import initialize_session_token

        session_token = initialize_session_token()
        logger.info("Session token initialized (length: %d)", len(session_token))

        # Validate Config (Fail-Fast)
        from src.core.app.startup_validator import validate_startup_config

        # Run blocking validation in a thread to avoid blocking the event loop
        await asyncio.get_running_loop().run_in_executor(
            None, validate_startup_config, settings, PROJECT_ROOT
        )
        logger.info("Startup configuration validated.")

        # Initialize Application State
        state = AppState()
        app.state.app_state = state

        # Initialize core app in background so setup endpoints can be served immediately.
        async def _background_init():
            try:
                await state.initialize()
                if state.core.initialized:
                    logger.info("Core initialization complete.")
                else:
                    logger.warning(
                        "Core initialization finished but core is not initialized (setup required)."
                    )
            except Exception as e:
                logger.error("Core initialization task failed: %s", e, exc_info=True)

        asyncio.create_task(_background_init())

        logger.info("Tepora Web Server ready (core init running in background).")
    except Exception as e:
        logger.critical("Critical failure during startup: %s", e, exc_info=True)
        raise

    yield

    logger.info("Tepora Web Server shutting down...")

    # Cleanup MCP resources
    if hasattr(app.state, "app_state") and app.state.app_state:
        await app.state.app_state.shutdown()


def create_app() -> FastAPI:
    app = FastAPI(title="Tepora AI Agent", version="0.2.0-beta", lifespan=lifespan)

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
        logger.info(
            "%s %s - %s - %.2fms",
            request.method,
            request.url.path,
            response.status_code,
            process_time,
        )
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
        project_root = (
            current_file.parent.parent.parent.parent
        )  # src/tepora_server/app_factory.py -> backend -> project_root
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
                try:
                    # Security Check: Ensure path does not traverse outside dist
                    # Using SecurityUtils for strict check (P1-1 Fix)
                    file_path = frontend_dist / full_path
                    if not SecurityUtils.validate_path_is_safe(file_path, frontend_dist):
                        logger.warning("Blocked path traversal attempt: %s", full_path)
                        return JSONResponse(status_code=404, content={"error": "Not Found"})

                    if file_path.exists() and file_path.is_file():
                        return FileResponse(str(file_path))
                except Exception:
                    # Catch security validation errors or path errors
                    return JSONResponse(status_code=404, content={"error": "Not Found"})

                # SPA Fallback
                index_path = frontend_dist / "index.html"
                if index_path.exists():
                    return FileResponse(str(index_path))

                return JSONResponse(status_code=404, content={"error": "Not Found"})
    except Exception as e:
        logger.warning("Could not setup static file serving: %s", e, exc_info=True)

    return app
