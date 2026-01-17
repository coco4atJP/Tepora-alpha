from __future__ import annotations

from pathlib import Path

import yaml

from src.core.config.service import ConfigService


def test_update_config_drops_unrestorable_redacted_values(tmp_path: Path) -> None:
    config_path = tmp_path / "config.yml"
    secrets_path = tmp_path / "secrets.yaml"

    # Simulate a minimal/old config that relies on defaults (no chat_history section)
    config_path.write_text("", encoding="utf-8")

    service = ConfigService(
        config_path=config_path,
        secrets_path=secrets_path,
        user_data_dir=tmp_path,
    )

    # Simulate a buggy/redacted frontend payload (e.g., max_tokens incorrectly "****")
    payload = {"chat_history": {"max_tokens": "****"}}

    ok, errors = service.update_config(payload, merge=False)

    assert ok is True
    assert errors is None

    saved = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    assert saved.get("chat_history", {}).get("max_tokens") != "****"
