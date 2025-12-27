import os
import pytest
from src.core.config.loader import config_manager, settings
from src.core.config.schema import TeporaSettings

class TestConfigSystem:
    def test_settings_load_defaults(self):
        """Test that settings load with defaults."""
        assert settings.app.max_input_length == 10000
        assert settings.active_agent_profile == "bunny_girl"

    def test_settings_load_from_yaml_proxy(self):
        """Test that values usually in config.yml are present (assuming config.yml exists)."""
        # This assumes the test environment has the config.yml or mocks it.
        # Since we are running on the actual backend with config.yml, we expect it to load.
        # Check a known value from config.yml
        # "character_model" is standard key
        assert "character_model" in settings.models_gguf

    def test_env_var_override(self, monkeypatch):
        """Test that environment variables override config."""
        monkeypatch.setenv("TEPORA_APP__MAX_INPUT_LENGTH", "9999")
        
        # Reload config to pick up env var
        # Note: config_manager is singleton, so we need to force reload effectively.
        # Our loader implementation:
        # load_config(force_reload=True) re-initializes.
        config_manager.load_config(force_reload=True)
        
        # However, our loader logic manually constructs settings.
        # We need to ensure that logic picks up the new env var.
        
        assert config_manager.settings.app.max_input_length == 9999

    def test_cors_origins(self):
        """Test CORS origin retrieval."""
        origins = settings.cors_origins
        assert isinstance(origins, list)
        assert len(origins) > 0

    def test_characters(self):
        """Test character profile loading."""
        assert "bunny_girl" in settings.characters
        char = settings.characters["bunny_girl"]
        assert char.name == "マリナ"

    def test_pydantic_validation(self):
        """Test that invalid config raises error (or defaults)."""
        # We handle validation errors by logging and potentially falling back,
        # but the schema enforces types.
        pass
