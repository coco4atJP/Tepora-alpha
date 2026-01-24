import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

# Add the parent directory to the Python path to allow module imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# --- Mocks for missing dependencies ---
try:
    import torch
except ImportError:
    torch = MagicMock()
    torch.cuda = MagicMock()
    torch.cuda.is_available = MagicMock(return_value=False)
    sys.modules["torch"] = torch

try:
    import langchain_mcp_adapters.client  # noqa: F401
except ImportError:
    mock_mcp_pkg = MagicMock()
    mock_mcp_client_module = MagicMock()
    mock_mcp_client_module.MultiServerMCPClient = MagicMock()
    mock_mcp_client_module.StdioConnection = MagicMock()
    mock_mcp_pkg.client = mock_mcp_client_module
    sys.modules["langchain_mcp_adapters"] = mock_mcp_pkg
    sys.modules["langchain_mcp_adapters.client"] = mock_mcp_client_module

try:
    import networkx as nx  # noqa: F401
except ImportError:
    nx = MagicMock()
    sys.modules["networkx"] = nx

try:
    from sklearn.metrics.pairwise import cosine_similarity  # noqa: F401
except ImportError:
    sklearn_stub = MagicMock()
    metrics_stub = MagicMock()
    pairwise_stub = MagicMock()
    pairwise_stub.cosine_similarity = MagicMock()
    metrics_stub.pairwise = pairwise_stub
    sklearn_stub.metrics = metrics_stub
    sys.modules["sklearn"] = sklearn_stub
    sys.modules["sklearn.metrics"] = metrics_stub
    sys.modules["sklearn.metrics.pairwise"] = pairwise_stub

try:
    import nltk  # noqa: F401
except ImportError:
    nltk_stub = MagicMock()
    nltk_stub.data = MagicMock()
    nltk_stub.data.load = MagicMock(side_effect=LookupError("punkt not found"))
    nltk_stub.download = MagicMock()
    sys.modules["nltk"] = nltk_stub

# --- Imports under test ---
from src.core.em_llm import EMConfig, EMEventSegmenter, EMLLMIntegrator
from src.core.graph import GraphRoutes, InputMode, route_by_command
from src.core.llm.service import LLMService
from src.core.memory.memory_system import MemorySystem


class TestLLMService(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        """Set up a fresh LLMService instance with mocked components."""
        self.registry_patcher = patch("src.core.llm.service.ModelRegistry")
        self.client_factory_patcher = patch("src.core.llm.service.ClientFactory")

        self.MockRegistry = self.registry_patcher.start()
        self.MockClientFactory = self.client_factory_patcher.start()

        self.mock_registry = self.MockRegistry.return_value
        self.mock_client_factory = self.MockClientFactory.return_value

        self.runner = MagicMock()
        self.runner.start = AsyncMock(return_value=12345)
        self.runner.stop = AsyncMock()
        self.runner.cleanup = MagicMock()

        mock_config = MagicMock()
        mock_config.n_ctx = 1024
        mock_config.n_gpu_layers = -1
        self.mock_registry.get_model_config.return_value = mock_config

        mock_model_path = MagicMock(spec=Path)
        mock_model_path.exists.return_value = True
        mock_model_path.__str__.return_value = "fake/model.gguf"
        self.mock_registry.resolve_model_path.return_value = mock_model_path

        self.service = LLMService(runner=self.runner, cache_size=3)

    def tearDown(self):
        """Clean up by stopping the patchers."""
        self.service.cleanup()
        self.registry_patcher.stop()
        self.client_factory_patcher.stop()

    def test_initialization(self):
        """Test that the LLMService initializes with mocked components."""
        self.assertEqual(self.service._chat_model_cache, {})
        self.assertIsNone(self.service._embedding_client)
        # Components should be initialized
        self.MockRegistry.assert_called_once()
        self.MockClientFactory.assert_called_once()

    async def test_load_character_client_success(self):
        """Test the successful loading and caching of the character chat client."""
        mock_client = MagicMock()
        self.mock_client_factory.create_chat_client.return_value = mock_client

        # Action
        llm = await self.service.get_client("character")

        self.mock_registry.get_model_config.assert_called_with("character_model")
        self.mock_registry.resolve_model_path.assert_called_with(
            "character_model", task_type="default"
        )
        self.runner.start.assert_called_once()
        self.mock_client_factory.create_chat_client.assert_called_once_with(
            "character_model",
            12345,
            self.mock_registry.get_model_config.return_value,
        )
        self.assertEqual(llm, mock_client)

        # Cached call should not start runner again
        llm2 = await self.service.get_client("character")
        self.assertEqual(llm2, mock_client)
        self.assertEqual(self.runner.start.call_count, 1)

    async def test_load_embedding_client_success(self):
        """Test the successful loading and caching of the embedding client."""
        mock_embedding_client = MagicMock()
        self.mock_client_factory.create_embedding_client.return_value = mock_embedding_client

        llm = await self.service.get_embedding_client()

        self.mock_registry.get_model_config.assert_called_with("embedding_model")
        self.mock_registry.resolve_model_path.assert_called_with("embedding_model")
        self.runner.start.assert_called_once()
        self.mock_client_factory.create_embedding_client.assert_called_once_with("embedding_model", 12345)
        self.assertEqual(llm, mock_embedding_client)

    async def test_cache_eviction_when_size_1(self):
        """Test switching models evicts the oldest when cache size is 1."""
        runner = MagicMock()
        runner.start = AsyncMock(side_effect=[8000, 8001])
        runner.stop = AsyncMock()
        runner.cleanup = MagicMock()

        self.mock_client_factory.create_chat_client.side_effect = [MagicMock(), MagicMock()]

        service = LLMService(runner=runner, cache_size=1)
        await service.get_client("character")
        await service.get_client("executor", task_type="default")

        runner.stop.assert_called_with("character_model")
        self.assertNotIn("character_model", service._chat_model_cache)
        self.assertIn("executor_model:default", service._chat_model_cache)

        service.cleanup()
        runner.cleanup.assert_called_once()


# --- The rest of the tests (MemorySystem, EMEventSegmenter, etc.) are preserved below ---


class TestMemorySystem(unittest.TestCase):
    def setUp(self):
        embedding_provider = MagicMock()
        embedding_provider.encode.return_value = [[0.1, 0.2, 0.3]]
        self.embedding_provider = embedding_provider

        with patch("chromadb.PersistentClient") as mock_client:
            mock_collection = MagicMock()
            mock_client.return_value.get_or_create_collection.return_value = mock_collection
            self.memory_system = MemorySystem(
                self.embedding_provider, db_path="./test_db", collection_name="test_memory"
            )
            self.collection = mock_collection

    def test_retrieve_handles_missing_distances(self):
        query_embedding = [[0.5, 0.6, 0.7]]
        self.embedding_provider.encode.return_value = query_embedding

        self.collection.query.return_value = {
            "ids": [["id1", "id2"]],
            "distances": None,
            "metadatas": [
                [
                    {"created_ts": 100, "history_json": "{}", "metadata_json": "{}"},
                    {"created_ts": 50, "history_json": "{}", "metadata_json": "{}"},
                ]
            ],
            "documents": [["summary1", "summary2"]],
        }

        results = self.memory_system.retrieve("test-query", k=2)

        self.assertEqual(len(results), 2)
        for result in results:
            self.assertIn("score", result)

    def test_retrieve_handles_short_distance_list(self):
        query_embedding = [[0.5, 0.6, 0.7]]
        self.embedding_provider.encode.return_value = query_embedding

        self.collection.query.return_value = {
            "ids": [["id1", "id2", "id3"]],
            "distances": [[0.0, 0.1, 0.2]],
            "metadatas": [
                [
                    {"created_ts": 100, "history_json": "{}", "metadata_json": "{}"},
                    {"created_ts": 90, "history_json": "{}", "metadata_json": "{}"},
                    {"created_ts": 80, "history_json": "{}", "metadata_json": "{}"},
                ]
            ],
            "documents": [["summary1", "summary2", "summary3"]],
        }

        results = self.memory_system.retrieve("test-query", k=3)

        self.assertEqual(len(results), 3)
        self.assertEqual(results[0]["id"], "id1")
        self.collection.query.assert_called_once()


class TestEMEventSegmenter(unittest.TestCase):
    def test_fallback_tokenizer_used_when_punkt_unavailable(self):
        with (
            patch("nltk.data.load", side_effect=LookupError("missing data")) as mock_load,
            patch("nltk.download", side_effect=Exception("offline")) as mock_download,
        ):
            segmenter = EMEventSegmenter(EMConfig())

        mock_load.assert_called_once_with("tokenizers/punkt/english.pickle")
        mock_download.assert_called_once_with("punkt", quiet=True)
        self.assertEqual(segmenter.sent_tokenizer.__class__.__name__, "_SimpleSentenceTokenizer")

        sentences = segmenter._split_into_sentences("Hello world. Next line!\nFinal question?")
        self.assertGreaterEqual(len(sentences), 2)
        self.assertIn("Hello world", sentences[0])


class TestEMLLMIntegrator(unittest.IsolatedAsyncioTestCase):
    async def test_process_logprobs_skips_invalid_entries(self):
        tokenizer_stub = MagicMock()
        tokenizer_stub.tokenize.side_effect = lambda text: text.split()

        with patch(
            "src.core.em_llm.segmenter.EMEventSegmenter._get_sentence_tokenizer",
            return_value=tokenizer_stub,
        ):
            memory_system = MagicMock()
            integrator = EMLLMIntegrator(
                llm_diagnostics_provider=None,
                embedding_provider=MagicMock(),
                config=EMConfig(),
                memory_system=memory_system,
            )

        integrator.segmenter.calculate_surprise_from_logprobs = MagicMock(return_value=[0.3, 0.2])
        integrator.segmenter._identify_event_boundaries = MagicMock(return_value=[0, 2])

        captured = {}

        async def fake_finalize(events):
            captured["events"] = events
            return events

        integrator._finalize_and_store_events = AsyncMock(side_effect=fake_finalize)

        logprobs_payload = [
            {"token": "token_a", "logprob": -0.1},
            {"token": "token_missing_logprob"},
            {"logprob": -0.2},
            {"token_str": "token_b", "logprob": -0.3},
        ]

        results = await integrator.process_logprobs_for_memory(logprobs_payload)

        integrator.segmenter.calculate_surprise_from_logprobs.assert_called_once()
        passed_entries = integrator.segmenter.calculate_surprise_from_logprobs.call_args[0][0]
        self.assertEqual(len(passed_entries), 2)
        self.assertTrue(all("token" in entry for entry in passed_entries))
        self.assertEqual(passed_entries[1]["token"], "token_b")

        integrator.segmenter._identify_event_boundaries.assert_called()
        integrator._finalize_and_store_events.assert_called_once()
        self.assertEqual(len(results), 1)
        self.assertEqual(captured["events"][0].tokens, ["token_a", "token_b"])


class TestGraphRouting(unittest.TestCase):
    def test_route_defaults_to_direct_answer(self):
        state = {"mode": InputMode.DIRECT}
        self.assertEqual(route_by_command(state), GraphRoutes.DIRECT_ANSWER)

    def test_route_search(self):
        state = {"mode": InputMode.SEARCH}
        self.assertEqual(route_by_command(state), GraphRoutes.SEARCH)

    def test_route_agent_mode(self):
        state = {"mode": InputMode.AGENT}
        self.assertEqual(route_by_command(state), GraphRoutes.AGENT_MODE)

    def test_route_stats(self):
        state = {"mode": InputMode.STATS}
        self.assertEqual(route_by_command(state), GraphRoutes.STATS)


if __name__ == "__main__":
    unittest.main()
