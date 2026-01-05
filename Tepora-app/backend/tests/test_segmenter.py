import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.core.em_llm.segmenter import EMEventSegmenter
from src.core.em_llm.types import EMConfig


class TestEMEventSegmenter(unittest.TestCase):
    def setUp(self):
        self.config = EMConfig(
            surprise_gamma=0.1, min_event_size=5, max_event_size=20, surprise_window=3
        )
        self.segmenter = EMEventSegmenter(self.config)

    def test_calculate_surprise_from_logprobs(self):
        logprobs = [
            {"token_str": "Hello", "logprob": -0.1},
            {"token_str": "world", "logprob": -0.5},
            {"token_str": "!", "logprob": -0.01},
        ]
        surprise = self.segmenter.calculate_surprise_from_logprobs(logprobs)
        self.assertEqual(len(surprise), 3)
        self.assertAlmostEqual(surprise[0], 0.1)
        self.assertAlmostEqual(surprise[1], 0.5)
        self.assertAlmostEqual(surprise[2], 0.01)

    def test_identify_event_boundaries(self):
        # Create a sequence of scores with a clear spike
        # Window size is 3.
        # T = mean + gamma * std
        scores = [0.1, 0.1, 0.1, 0.1, 0.1, 0.9, 0.1, 0.1]
        # Indices: 0    1    2    3    4    5    6    7

        # At index 5: window is [0.1, 0.1, 0.1] (indices 2,3,4)
        # Mean = 0.1, Std = 0.0
        # Threshold = 0.1 + 0.1 * 0.0 = 0.1
        # Score 0.9 > 0.1 -> Boundary!

        boundaries = self.segmenter._identify_event_boundaries(scores)

        self.assertIn(0, boundaries)
        self.assertIn(5, boundaries)
        self.assertIn(len(scores), boundaries)

    def test_segment_text_into_events_short_text(self):
        mock_embedding_provider = MagicMock()
        text = "Short text."
        events, embeddings = self.segmenter.segment_text_into_events(text, mock_embedding_provider)

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].start_position, 0)
        self.assertIsNone(embeddings)

    def test_segment_text_into_events_semantic(self):
        mock_embedding_provider = MagicMock()
        # Mock embeddings for 3 sentences
        # s1 and s2 are similar, s3 is different
        s1_emb = np.array([1.0, 0.0])
        s2_emb = np.array([0.9, 0.1])  # Close to s1
        s3_emb = np.array([0.0, 1.0])  # Far from s2

        mock_embedding_provider.encode.return_value = [s1_emb, s2_emb, s3_emb]

        text = "Sentence one. Sentence two. Sentence three."

        # We need to patch _split_into_sentences to return our 3 sentences
        with patch.object(
            self.segmenter,
            "_split_into_sentences",
            return_value=["Sentence one.", "Sentence two.", "Sentence three."],
        ):
            # And patch _identify_event_boundaries to return a boundary at index 2 (start of s3)
            # Boundaries: 0 (start), 2 (start of s3), 3 (end)
            with patch.object(self.segmenter, "_identify_event_boundaries", return_value=[0, 2, 3]):
                events, embeddings = self.segmenter.segment_text_into_events(
                    text, mock_embedding_provider
                )

                self.assertEqual(len(events), 2)
                # Event 1: s1, s2
                self.assertEqual(events[0].tokens, "Sentence one. Sentence two.".split())
                # Event 2: s3
                self.assertEqual(events[1].tokens, "Sentence three.".split())


if __name__ == "__main__":
    unittest.main()
