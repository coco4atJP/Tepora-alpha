import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.core.graph.nodes.em_llm import EMMemoryNodes


class TestEMMemoryNodes(unittest.TestCase):
    def setUp(self):
        self.mock_integrator = MagicMock()
        self.memory_nodes = EMMemoryNodes(self.mock_integrator)

    def test_em_memory_retrieval_node_no_results(self):
        self.mock_integrator.retrieve_relevant_memories_for_query.return_value = []
        state = {"input": "test query"}
        result = self.memory_nodes.em_memory_retrieval_node(state)

        self.assertEqual(result["recalled_episodes"], [])
        self.assertIn("No relevant episodic memories found", result["synthesized_memory"])

    def test_em_memory_retrieval_node_with_results(self):
        events = [{"content": "memory", "surprise_stats": {"mean_surprise": 0.5}}]
        self.mock_integrator.retrieve_relevant_memories_for_query.return_value = events

        state = {"input": "test query"}
        result = self.memory_nodes.em_memory_retrieval_node(state)

        self.assertEqual(result["recalled_episodes"], events)
        self.assertIn("Recalled Event 1", result["synthesized_memory"])
        self.assertIn("memory", result["synthesized_memory"])
        self.mock_integrator.retrieve_relevant_memories_for_query.assert_called_once_with(
            "test query"
        )


if __name__ == "__main__":
    unittest.main()
