import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.core.em_llm.retrieval import EMTwoStageRetrieval
from src.core.em_llm.types import EMConfig, EpisodicEvent


class TestEMTwoStageRetrieval(unittest.TestCase):
    def setUp(self):
        self.config = EMConfig(
            total_retrieved_events=5,
            similarity_buffer_ratio=0.6,  # 3 sim, 2 cont
        )
        self.mock_memory_system = MagicMock()
        self.retrieval = EMTwoStageRetrieval(self.config, self.mock_memory_system)

    def test_add_events(self):
        event = EpisodicEvent(
            tokens=["test", "event"],
            start_position=0,
            end_position=2,
            surprise_scores=[0.1, 0.2],
            representative_embeddings=np.array([[0.1, 0.1]]),
        )

        self.retrieval.add_events([event])

        self.mock_memory_system.collection.add.assert_called_once()
        call_args = self.mock_memory_system.collection.add.call_args[1]
        # Event ID now includes a unique suffix (8-character hex UUID)
        self.assertEqual(len(call_args["ids"]), 1)
        event_id = call_args["ids"][0]
        self.assertTrue(
            event_id.startswith("em_event_0_2_"),
            f"Event ID should start with 'em_event_0_2_', got '{event_id}'",
        )
        self.assertEqual(call_args["documents"], ["test event"])


    def test_retrieve_relevant_events(self):
        # Mock similarity retrieval results
        sim_event = EpisodicEvent(
            tokens=["sim"], start_position=10, end_position=15, surprise_scores=[]
        )

        # Mock contiguity retrieval results
        cont_event = EpisodicEvent(
            tokens=["cont"], start_position=15, end_position=20, surprise_scores=[]
        )

        with patch.object(self.retrieval, "_similarity_based_retrieval", return_value=[sim_event]):
            with patch.object(
                self.retrieval, "_contiguity_based_retrieval", return_value=[cont_event]
            ):
                query_emb = np.array([0.1, 0.1])
                results = self.retrieval.retrieve_relevant_events(query_emb)

                self.assertEqual(len(results), 2)
                # Should be sorted by start position
                self.assertEqual(results[0].start_position, 10)
                self.assertEqual(results[1].start_position, 15)

    def test_deduplicate_events(self):
        e1 = EpisodicEvent(tokens=["a"], start_position=0, end_position=1, surprise_scores=[])
        e2 = EpisodicEvent(
            tokens=["a"], start_position=0, end_position=1, surprise_scores=[]
        )  # Duplicate
        e3 = EpisodicEvent(tokens=["b"], start_position=1, end_position=2, surprise_scores=[])

        deduped = self.retrieval._deduplicate_events([e1, e2, e3])
        self.assertEqual(len(deduped), 2)


if __name__ == "__main__":
    unittest.main()
