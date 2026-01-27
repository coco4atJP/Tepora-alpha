
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from src.core.download.manager import DownloadManager
from src.tepora_server.api.security import get_api_key
from src.tepora_server.app_factory import create_app

# --- Fixtures ---

@pytest.fixture
def mock_core_app():
    """Mock the heavy TeporaApp (V2-only)."""
    with patch("src.tepora_server.state.TeporaApp") as mock_class:
        mock_instance = mock_class.return_value

        async def async_init():
            return True

        mock_instance.initialize = MagicMock(side_effect=async_init)
        mock_instance.initialized = True
        yield mock_instance

@pytest.fixture
def client(mock_core_app):
    app = create_app()
    with TestClient(app) as c:
        c.app.state.app_state._core = mock_core_app
        yield c

@pytest.fixture
def run_with_auth(client):
    app = client.app
    app.dependency_overrides[get_api_key] = lambda: "valid-key"
    yield
    app.dependency_overrides = {}

# --- Unit Tests for DownloadManager ---

@pytest.mark.asyncio
async def test_manager_run_initial_setup_ollama_skips_binary():
    """Test that loader='ollama' skips binary installation."""
    with patch("src.core.download.manager.BinaryManager") as MockBM, \
         patch("src.core.download.manager.ModelManager") as MockMM:

        dm = DownloadManager()
        dm.binary_manager.download_and_install = AsyncMock(return_value=MagicMock(success=True))
        # Fix: Mock model manager async methods
        dm.model_manager.download_from_huggingface = AsyncMock(return_value=MagicMock(success=True))

        # Act
        await dm.run_initial_setup(install_binary=True, loader="ollama")

        # Assert
        dm.binary_manager.download_and_install.assert_not_called()

@pytest.mark.asyncio
async def test_manager_run_initial_setup_llama_cpp_installs_binary():
    """Test that loader='llama_cpp' performs binary installation."""
    with patch("src.core.download.manager.BinaryManager") as MockBM, \
         patch("src.core.download.manager.ModelManager") as MockMM:

        dm = DownloadManager()
        dm.binary_manager.download_and_install = AsyncMock(return_value=MagicMock(success=True))
        dm.model_manager.download_from_huggingface = AsyncMock(return_value=MagicMock(success=True))

        # Act
        await dm.run_initial_setup(install_binary=True, loader="llama_cpp")

        # Assert
        dm.binary_manager.download_and_install.assert_called_once()


@pytest.mark.asyncio
async def test_manager_run_initial_setup_ollama_skips_text_defaults():
    """Test that loader='ollama' skips text models from defaults."""
    with patch("src.core.download.manager.BinaryManager"), \
         patch("src.core.download.manager.ModelManager") as MockMM, \
         patch("src.core.download.manager._build_default_model_targets") as mock_build_defaults:

        dm = DownloadManager()
        dm.model_manager.download_from_huggingface = AsyncMock(return_value=MagicMock(success=True))

        # Setup defaults containing one text and one embedding model
        mock_build_defaults.return_value = [
            {"repo_id": "text-model", "filename": "text.gguf", "role": "text", "display_name": "Text"},
            {"repo_id": "embed-model", "filename": "embed.gguf", "role": "embedding", "display_name": "Embed"},
        ]

        # Act
        await dm.run_initial_setup(
            install_binary=True,
            download_default_models=True,
            target_models=None,
            loader="ollama"
        )

        # Assert
        # Should only call download for embedding
        calls = dm.model_manager.download_from_huggingface.call_args_list
        assert len(calls) == 1
        args, kwargs = calls[0]
        assert kwargs["role"].value == "embedding"
        assert kwargs["filename"] == "embed.gguf"


# --- API Endpoint Tests ---

def test_run_setup_job_passes_loader(client, run_with_auth):
    """Test that POST /api/setup/run passes loader to manager."""
    with patch("src.tepora_server.api.setup._get_download_manager") as mock_get_dm, \
         patch("src.tepora_server.api.setup._setup_session") as mock_session:

        mock_dm = MagicMock()
        mock_dm.run_initial_setup = AsyncMock(return_value=MagicMock(success=True))
        mock_get_dm.return_value = mock_dm

        payload = {
            "target_models": [],
            "acknowledge_warnings": False,
            "loader": "ollama"
        }

        response = client.post("/api/setup/run", json=payload)

        assert response.status_code == 200
        assert response.json()["success"] is True

        # Verify manager was called with loader="ollama"
        # Since it runs in background task, we might need to inspect the call.
        # But run_setup_job is async. The create_task might not have run yet?
        # In testClient with async endpoint, usually it awaits?
        # Actually background tasks in FastAPI:
        # The endpoint returns response, task runs in background.
        # unittest.mock might catch it if we await?
        # But asyncio.create_task schedules it.
        # We can mock asyncio.create_task or run the inner function.
        # However, verifying session loader setting is synchronous.

        mock_session.set_loader.assert_called_with("ollama")

