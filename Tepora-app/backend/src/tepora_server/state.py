"""
Application State Management

Provides centralized state management for the Tepora web server.
Supports both global access (legacy) and dependency injection patterns.
"""
from typing import Optional
from fastapi import Request, WebSocket
from src.core.app.core import TeporaCoreApp


class AppState:
    """
    Centralized application state container.
    
    Manages the lifecycle of the core application instance.
    Supports lazy initialization for flexibility.
    """
    
    def __init__(self):
        self._core: Optional[TeporaCoreApp] = None
    
    @property
    def core(self) -> TeporaCoreApp:
        """Get or create the TeporaCoreApp instance."""
        if self._core is None:
            self._core = TeporaCoreApp()
        return self._core
    
    @core.setter
    def core(self, value: TeporaCoreApp) -> None:
        """Set the TeporaCoreApp instance (for testing/mocking)."""
        self._core = value
    
    async def initialize(self) -> bool:
        """Initialize the core app."""
        return await self.core.initialize()


# --- Dependency Injection Helpers ---

def get_app_state(request: Request) -> AppState:
    """
    Get the AppState instance from the request object.
    
    Args:
        request: The FastAPI request object.
        
    Returns:
        The AppState instance attached to the app.
        
    Raises:
        AttributeError: If app.state.app_state is not set.
    """
    return request.app.state.app_state


def get_app_state_from_websocket(websocket: WebSocket) -> AppState:
    """
    Get AppState for WebSocket endpoints.
    
    Args:
        websocket: The FastAPI WebSocket object.
        
    Returns:
        The AppState instance attached to the app.
    """
    return websocket.app.state.app_state
