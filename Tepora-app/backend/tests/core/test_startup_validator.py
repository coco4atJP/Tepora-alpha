from unittest.mock import MagicMock

import pytest

from src.core.app.startup_validator import validate_startup_config


@pytest.fixture
def mock_config():
    config = MagicMock()
    # Defaults for minimal valid config
    config.models_gguf = {"test_model": MagicMock(path="models/test.gguf", port=8080)}
    config.em_llm = MagicMock(surprise_gamma=0.5, min_event_size=1, max_event_size=10)
    return config


@pytest.fixture
def mock_root(tmp_path):
    # Mock project root
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    (models_dir / "test.gguf").touch()
    return tmp_path


def test_validate_valid_config(mock_config, mock_root):
    # Should not raise exception
    validate_startup_config(mock_config, mock_root)


def test_validate_missing_models_section(mock_config, mock_root, caplog):
    mock_config.models_gguf = {}
    with caplog.at_level("WARNING"):
        validate_startup_config(mock_config, mock_root)
    assert "models_gguf section is missing" in caplog.text


def test_validate_missing_model_path(mock_config, mock_root):
    mock_config.models_gguf["test_model"].path = None
    with pytest.raises(ValueError, match="path] is missing"):
        validate_startup_config(mock_config, mock_root)


def test_validate_model_file_not_found(mock_config, mock_root, caplog):
    mock_config.models_gguf["test_model"].path = "models/nonexistent.gguf"
    with caplog.at_level("WARNING"):
        validate_startup_config(mock_config, mock_root)
    assert "Model file not found" in caplog.text


def test_validate_invalid_port(mock_config, mock_root):
    mock_config.models_gguf["test_model"].port = 80
    with pytest.raises(ValueError, match="must be an integer between 1024 and 65535"):
        validate_startup_config(mock_config, mock_root)


def test_validate_invalid_gamma(mock_config, mock_root):
    mock_config.em_llm.surprise_gamma = 1.5
    with pytest.raises(ValueError, match="must be between 0.0 and 1.0"):
        validate_startup_config(mock_config, mock_root)


def test_validate_event_size_order(mock_config, mock_root):
    mock_config.em_llm.min_event_size = 20
    mock_config.em_llm.max_event_size = 10
    with pytest.raises(ValueError, match="cannot be greater than"):
        validate_startup_config(mock_config, mock_root)
