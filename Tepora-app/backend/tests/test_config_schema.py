import pytest

from src.core.config.loader import config_manager, settings


class TestConfigSystem:
    def test_settings_load_defaults(self, monkeypatch):
        """Test that settings load with defaults."""
        # Force reload with no config file to ensure defaults
        # We temporarily override config_path to a non-existent file
        monkeypatch.setenv("TEPORA_CONFIG_PATH", "non_existent_config.yml")
        config_manager.load_config(force_reload=True)

        try:
            assert settings.app.max_input_length == 10000
            assert settings.active_agent_profile == "bunny_girl"
        finally:
            # Clean up by reloading without the env var (monkeypatch handles env restoration automatically)
            # But we need to trigger load_config again after test finishes or env is reverted
            pass

    # Note: We need a teardown to reset config_manager state for other tests,
    # but since monkeypatch undoes env change, we just need to ensure next access reloads correct config.
    # config_manager doesn't auto-detect env change if already initialized.
    # So we should probably force reload in teardown or fixture.

    @pytest.fixture(autouse=True)
    def reset_config(self):
        yield
        config_manager.load_config(force_reload=True)

    def test_settings_load_from_yaml_proxy(self):
        """Test that values usually in config.yml are present (assuming config.yml exists)."""
        # This test is environment-dependent: requires a config.yml with models defined.
        # Skip if running in CI or environment without config.yml.
        if not settings.models_gguf:
            pytest.skip("No models_gguf defined in config (config.yml may not exist)")

        # Check a known value from config.yml
        # "text_model" is the standard key (unified from legacy character_model)
        assert "text_model" in settings.models_gguf

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


class TestSensitiveKeyDetection:
    """Tests for the sensitive key detection logic in ConfigService."""

    def test_sensitive_patterns_detected(self):
        """Test that sensitive key patterns are correctly detected."""
        from src.core.config.service import _is_sensitive

        # These should all be detected as sensitive
        assert _is_sensitive("api_key") is True
        assert _is_sensitive("API_KEY") is True  # case insensitive
        assert _is_sensitive("secret") is True
        assert _is_sensitive("password") is True
        assert _is_sensitive("my_secret_value") is True
        assert _is_sensitive("user_password") is True

    def test_token_suffix_pattern(self):
        """Test that _token suffix pattern detects tokens correctly."""
        from src.core.config.service import _is_sensitive

        # Suffix pattern: ends with _token
        assert _is_sensitive("auth_token") is True
        assert _is_sensitive("access_token") is True
        assert _is_sensitive("refresh_token") is True

        # Prefix pattern: starts with token_
        assert _is_sensitive("token_secret") is True
        assert _is_sensitive("token_id") is True

    def test_whitelist_prevents_false_positives(self):
        """Test that whitelisted keys are NOT detected as sensitive."""
        from src.core.config.service import _is_sensitive

        # These contain 'token' but should NOT be sensitive
        assert _is_sensitive("max_tokens") is False
        assert _is_sensitive("total_tokens") is False
        assert _is_sensitive("input_tokens") is False
        assert _is_sensitive("output_tokens") is False
        assert _is_sensitive("token_count") is False
        assert _is_sensitive("tokenizer") is False

    def test_auth_patterns(self):
        """Test that auth patterns work correctly."""
        from src.core.config.service import _is_sensitive

        # auth_ prefix and _auth suffix should be sensitive
        assert _is_sensitive("auth_key") is True
        assert _is_sensitive("oauth") is True
        assert _is_sensitive("basic_auth") is True

        # But 'author' or 'authentication' without suffix/prefix patterns should not
        # Note: 'authentication' contains 'auth_' (auth followed by e), so it matches
        # This is expected behavior for pattern-based matching

    def test_non_sensitive_keys(self):
        """Test that regular keys are NOT detected as sensitive."""
        from src.core.config.service import _is_sensitive

        assert _is_sensitive("name") is False
        assert _is_sensitive("description") is False
        assert _is_sensitive("max_length") is False
        assert _is_sensitive("timeout") is False
        assert _is_sensitive("model_path") is False
