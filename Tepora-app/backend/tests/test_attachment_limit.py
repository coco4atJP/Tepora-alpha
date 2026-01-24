import base64

import pytest

from src.core import config as core_config
from src.core.app_v2 import TeporaApp


class TestAttachmentSizeLimit:
    """Tests for attachment size limit validation in TeporaApp (V2-only)."""

    @pytest.fixture
    def app(self):
        return TeporaApp()

    def test_attachment_within_limit_decodes_base64(self, app):
        """Attachments under the size limit are decoded if they look like base64."""
        content = "Hello World " * 10
        encoded = base64.b64encode(content.encode("utf-8")).decode("utf-8")

        attachments = [{"name": "small_file.txt", "content": encoded, "type": "text/plain"}]

        processed = app._process_attachments(attachments)
        assert len(processed) == 1
        assert processed[0]["name"] == "small_file.txt"
        assert processed[0]["content"] == content

    def test_attachment_over_limit_is_skipped(self, app):
        """Attachments over the size limit are skipped for safety."""
        safe_limit = int(core_config.SEARCH_ATTACHMENT_SIZE_LIMIT * 1.35)
        too_large = "A" * (safe_limit + 1)

        attachments = [{"name": "huge.txt", "content": too_large, "type": "text/plain"}]
        processed = app._process_attachments(attachments)
        assert processed == []

    def test_non_base64_passes_through(self, app):
        attachments = [{"name": "plain.txt", "content": "plain text", "type": "text/plain"}]
        processed = app._process_attachments(attachments)
        assert processed == attachments
