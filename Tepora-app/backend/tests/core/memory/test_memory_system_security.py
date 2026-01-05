from unittest.mock import MagicMock

import pytest

from src.core.memory.memory_system import MemorySystem
from src.core.memory.vector_store import VectorStore


class TestMemorySystemSecurity:
    def test_retrieve_propagates_exceptions(self):
        """Test that retrieve raises exceptions instead of swallowing them."""
        # 1. Setup Mock Vector Store that raises Exception
        mock_store = MagicMock(spec=VectorStore)
        mock_store.query.side_effect = Exception("Database Connection Failed")

        # 2. Initialize MemorySystem with mock store
        # we need a dummy embedding provider
        mock_embedding = MagicMock()
        mock_embedding.encode.return_value = [[0.1, 0.2, 0.3]]

        memory = MemorySystem(mock_embedding, vector_store=mock_store)

        # 3. Call retrieve and expect failure
        with pytest.raises(Exception, match="Database Connection Failed"):
            memory.retrieve("test query")

    def test_save_episode_propagates_exceptions(self):
        """Test that save_episode propagates exceptions."""
        mock_store = MagicMock(spec=VectorStore)
        mock_store.add.side_effect = Exception("Write Failed")

        mock_embedding = MagicMock()
        mock_embedding.encode.return_value = [[0.1]]

        memory = MemorySystem(mock_embedding, vector_store=mock_store)

        with pytest.raises(Exception, match="Write Failed"):
            memory.save_episode("summary", "{}")
