import base64
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.core.app.core import TeporaCoreApp


class TestAttachmentSizeLimit:
    """Tests for attachment size limit validation in TeporaCoreApp."""

    @pytest.fixture
    def app(self):
        app = TeporaCoreApp()
        app.history_manager = MagicMock()
        app.history_manager.get_history.return_value = []
        app.app = AsyncMock()  # Mock the graph app
        return app

    async def test_attachment_within_limit(self, app):
        """Test that attachments within the limit are processed/decoded."""
        # Create a small valid base64 payload
        content = "Hello World"
        encoded = base64.b64encode(content.encode("utf-8")).decode("utf-8")

        attachments = [{"name": "small_file.txt", "content": encoded, "type": "text/plain"}]

        # We need to mock process_input to stop recursion or external calls
        # But process_user_request is where our logic is.
        # We can inspect the arguments passed to process_input to verify attachment status

        with patch.object(app, "process_input", return_value=AsyncMock()) as mock_process:
            # Iterate to trigger the generator
            async for _ in app.process_user_request("test payload", attachments=attachments):
                pass

            # Verify process_input was called
            assert mock_process.call_count == 1
            # call_args can be inspected for search_metadata if needed in future

            # The logic inside process_user_request decodes base64 if possible
            # But currently, process_user_request ONLY puts attachments into search_metadata IF mode is SEARCH

    async def test_attachment_processing_logic(self, app):
        """Directly test the attachment processing logic block by simulating input params."""
        # Since we modified process_user_request, we want to see if the attachment list
        # that gets passed down contains decoded content or is skipped.

        # Case A: Valid base64 > 100 chars but < Limit
        # "Hello World" repeated enough times to be > 100 chars
        small_content = "Hello World " * 10
        encoded_small = base64.b64encode(small_content.encode("utf-8")).decode("utf-8")
        assert len(encoded_small) > 100  # Verify constraint matches code logic

        # Case B: Huge base64 (simulated)
        # 1MB of 'A's is valid base64 (decodes to mostly 0x? depending on padding, but valid structure)
        # SEARCH_ATTACHMENT_SIZE_LIMIT is 512KB. 1MB > 512KB * 1.35
        huge_content = "A" * (1024 * 1024)

        attachments = [
            {"name": "valid.txt", "content": encoded_small, "type": "text/plain"},
            {"name": "huge.txt", "content": huge_content, "type": "text/plain"},
        ]

        # Mock process_input to capture the result
        with patch.object(app, "process_input") as mock_process_input:
            mock_process_input.return_value = AsyncMock()

            # mimic async generator
            async def async_gen():
                yield {"event": "done", "data": {}}

            mock_process_input.side_effect = lambda *args, **kwargs: async_gen()

            # We must use InputMode.SEARCH or similar so that attachments are actually used/passed?
            # Actually, `process_user_request` processes attachments regardless of mode,
            # BUT it only puts them into `search_metadata` if mode == SEARCH.
            # However, the logic we changed modifies the `processed_attachments` list.
            # We want to verify `processed_attachments` contents.
            # Since `process_user_request` is a generator, we can't easily inspect local vars.
            # BUT we can check what is passed to `process_input`.

            # Force SEARCH mode to ensure search_metadata is populated
            from src.core.graph.constants import InputMode

            await pd_loop(
                app.process_user_request("test", mode=InputMode.SEARCH, attachments=attachments)
            )

            # Verify call args
            assert mock_process_input.called
            call_args = mock_process_input.call_args
            search_metadata = call_args.kwargs.get("search_metadata")

            assert search_metadata is not None
            processed = search_metadata.get("search_attachments")

            # Check results
            assert len(processed) >= 1

            # 1. Valid file should be decoded
            small_file = next((x for x in processed if x["name"] == "valid.txt"), None)
            assert small_file is not None
            assert small_file["content"] == small_content  # Should be decoded

            # 2. Huge file should be MISSING (skipped)
            # The code loops and 'continue's, so it never gets appended
            huge_file = next((x for x in processed if x["name"] == "huge.txt"), None)
            assert huge_file is None


async def pd_loop(async_gen):
    """Helper to consume async generator"""
    async for _ in async_gen:
        pass
