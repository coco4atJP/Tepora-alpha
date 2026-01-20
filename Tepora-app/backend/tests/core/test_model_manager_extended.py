import unittest
from pathlib import Path
from unittest.mock import patch

from src.core.models.manager import ModelManager


class TestModelManagerExtended(unittest.TestCase):
    def setUp(self):
        self.models_dir = Path("./models")
        self.manager = ModelManager(self.models_dir)

    @patch("src.core.models.manager._fetch_hf_file_metadata")
    def test_get_remote_file_size_success(self, mock_fetch):
        # Mock successful metadata retrieval
        mock_fetch.return_value = {"size": 1024, "revision": "main", "sha256": "abc"}

        size = self.manager.get_remote_file_size("repo/id", "file.gguf")

        self.assertEqual(size, 1024)
        mock_fetch.assert_called_with("repo/id", "file.gguf", revision=None)

    @patch("src.core.models.manager._fetch_hf_file_metadata")
    def test_get_remote_file_size_not_found(self, mock_fetch):
        # Mock file not found (empty dict or no size)
        mock_fetch.return_value = {}

        size = self.manager.get_remote_file_size("repo/id", "missing.gguf")

        self.assertIsNone(size)

    @patch("src.core.models.manager._fetch_hf_file_metadata")
    def test_get_remote_file_size_with_revision(self, mock_fetch):
        mock_fetch.return_value = {"size": 2048}

        size = self.manager.get_remote_file_size("repo/id", "file.gguf", revision="dev")

        self.assertEqual(size, 2048)
        mock_fetch.assert_called_with("repo/id", "file.gguf", revision="dev")


if __name__ == "__main__":
    unittest.main()
