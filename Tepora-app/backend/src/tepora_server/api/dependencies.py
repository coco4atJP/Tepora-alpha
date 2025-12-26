"""
Centralized API Dependencies
"""
from fastapi import Depends
from src.tepora_server.state import AppState, get_app_state, get_app_state_from_websocket

__all__ = ["get_app_state", "get_app_state_from_websocket", "AppState"]
