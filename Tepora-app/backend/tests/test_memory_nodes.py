import unittest
from unittest.mock import MagicMock, patch
import sys
import os
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.core.graph.nodes.memory import MemoryNodes
from src.core.state import AgentState

class TestMemoryNodes(unittest.TestCase):
    def setUp(self):
        self.mock_memory_system = MagicMock()
        self.memory_nodes = MemoryNodes(self.mock_memory_system)

    def test_memory_retrieval_node_no_memory_system(self):
        # Test with None memory system
        nodes = MemoryNodes(None)
        state = {"input": "test query", "chat_history": []}
        result = nodes.memory_retrieval_node(state)
        
        self.assertIn("recalled_episodes", result)
        self.assertEqual(result["recalled_episodes"], [])
        self.assertIn("synthesized_memory", result)

    def test_memory_retrieval_node_with_memory(self):
        # Mock retrieval
        self.mock_memory_system.retrieve_similar_episodes.return_value = [{"content": "memory"}]

        state = {"input": "test query", "chat_history": []}
        result = self.memory_nodes.memory_retrieval_node(state)

        self.assertIn("recalled_episodes", result)
        self.assertEqual(len(result["recalled_episodes"]), 1)
        self.assertIn("synthesized_memory", result)
        self.mock_memory_system.retrieve_similar_episodes.assert_called_once()

    def test_save_memory_node(self):
        # Mock state with messages
        state = {
            "input": "user input",
            "chat_history": [MagicMock(content="ai response", __class__=MagicMock(__name__='AIMessage'))]
        }
        # Ensure isinstance check passes for AIMessage
        from langchain_core.messages import AIMessage
        state["chat_history"][0] = AIMessage(content="ai response")

        result = self.memory_nodes.save_memory_node(state)

        # Should call save_episode
        self.mock_memory_system.save_episode.assert_called_once()

if __name__ == '__main__':
    unittest.main()
