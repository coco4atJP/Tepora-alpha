"""
EM-LLM integrator - Main integration point.

This module provides the EMLLMIntegrator class that orchestrates
all EM-LLM components for memory formation and retrieval.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any, cast

import numpy as np

from .boundary import EMBoundaryRefiner
from .retrieval import EMTwoStageRetrieval
from .segmenter import EMEventSegmenter
from .types import EMConfig, EpisodicEvent

if TYPE_CHECKING:
    from ..embedding_provider import EmbeddingProvider
    from ..memory.memory_system import MemorySystem

logger = logging.getLogger(__name__)


class EMLLMIntegrator:
    """
    Integration class for EM-LLM with existing system.

    This class orchestrates:
    1. Event segmentation (surprise-based or semantic)
    2. Boundary refinement
    3. Representative token selection
    4. Memory storage and retrieval
    """

    def __init__(
        self,
        llm_diagnostics_provider: object | None,
        embedding_provider: EmbeddingProvider,
        config: EMConfig,
        memory_system: MemorySystem,
    ):
        """
        Initialize EM-LLM integrator.

        Args:
            llm_diagnostics_provider: Optional diagnostics provider for LLM config reporting
            embedding_provider: Provider for text embeddings
            config: EM-LLM configuration parameters
            memory_system: ChromaDB-backed memory system
        """
        self._llm_diagnostics_provider = llm_diagnostics_provider
        self.embedding_provider = embedding_provider
        self.config = config
        self.memory_system = memory_system

        # Initialize EM-LLM memory system
        self.segmenter = EMEventSegmenter(self.config)
        self.boundary_refiner = EMBoundaryRefiner(self.config)
        self.retrieval_system = EMTwoStageRetrieval(self.config, self.memory_system)

        logger.info("EM-LLM Integrator initialized")

    def get_current_llm_config_for_diagnostics(self) -> dict[str, Any]:
        """
        Get current LLM configuration for diagnostics.

        Returns:
            Dictionary with LLM configuration information
        """
        provider = self._llm_diagnostics_provider
        if provider and hasattr(provider, "get_current_model_config_for_diagnostics"):
            try:
                return cast(dict[str, Any], provider.get_current_model_config_for_diagnostics())
            except Exception:
                logger.debug("LLM diagnostics provider failed.", exc_info=True)
        return {}

    async def _finalize_and_store_events(self, events: list[EpisodicEvent]) -> list[EpisodicEvent]:
        """
        Common post-processing: select representative tokens, compute embeddings, store.

        Args:
            events: List of segmented events

        Returns:
            List of finalized events
        """
        if not events:
            return []

        # Select representative tokens and compute embeddings for each event
        for event in events:
            event.representative_tokens = self._select_representative_tokens(event)
            if self.embedding_provider and event.representative_tokens:
                repr_texts = [event.tokens[i] for i in event.representative_tokens]
                if repr_texts:
                    # Embedding computation is not async, so use asyncio.to_thread
                    embeddings = await asyncio.to_thread(self.embedding_provider.encode, repr_texts)
                    event.representative_embeddings = np.array(embeddings)

        # Store in memory
        self.retrieval_system.add_events(events)

        return events

    async def process_logprobs_for_memory(
        self, logprobs_content: list[dict]
    ) -> list[EpisodicEvent]:
        """
        Process LLM logprobs directly for surprise-based memory formation.

        This is the main memory formation path from the EM-LLM paper.

        Args:
            logprobs_content: List of logprob dictionaries from LLM

        Returns:
            List of created episodic events
        """
        logger.info("Processing logprobs for surprisal-based memory formation.")
        try:
            if not logprobs_content:
                logger.warning("logprobs_content is empty. Skipping memory formation.")
                return []

            # Normalize logprob entries
            normalized_entries = []
            for idx, entry in enumerate(logprobs_content):
                token = entry.get("token") or entry.get("token_str")
                logprob = entry.get("logprob")
                if token is None or logprob is None:
                    logger.debug(
                        "Skipping logprob entry %d due to missing token/logprob fields: %s",
                        idx,
                        entry,
                    )
                    continue
                normalized_entries.append({"token": token, "logprob": logprob})

            if not normalized_entries:
                logger.warning(
                    "No valid logprob entries after normalization. Skipping memory formation."
                )
                return []

            surprise_scores = self.segmenter.calculate_surprise_from_logprobs(normalized_entries)
            tokens = [item["token"] for item in normalized_entries]

            boundaries = self.segmenter._identify_event_boundaries(surprise_scores)

            events = []
            for i in range(len(boundaries) - 1):
                start, end = boundaries[i], boundaries[i + 1]
                event = EpisodicEvent(
                    tokens=tokens[start:end],
                    start_position=start,
                    end_position=end,
                    surprise_scores=surprise_scores[start:end],
                )
                events.append(event)

            # Boundary refinement (using attention keys if available)
            attention_keys = None  # Currently dummy
            if self.config.use_boundary_refinement and attention_keys is not None:
                logger.info("Applying boundary refinement using attention keys.")
                events = self.boundary_refiner.refine_boundaries(
                    events, attention_keys=attention_keys
                )

            return await self._finalize_and_store_events(events)
        except Exception as e:
            logger.error("EM-LLM logprobs processing failed: %s", e, exc_info=True)
            return []

    async def process_conversation_turn_for_memory(
        self, user_input: str, ai_response: str
    ) -> list[EpisodicEvent]:
        """
        Process conversation turn through EM-LLM memory formation pipeline.

        Args:
            user_input: User's input text
            ai_response: AI's response text

        Returns:
            List of created episodic events
        """
        logger.info(
            "Processing conversation turn for EM-LLM memory formation (semantic change based)."
        )

        try:
            if not ai_response:
                logger.warning("AI response is empty. Aborting memory formation.")
                return []

            # Semantic change-based memory formation pipeline
            logger.info("Processing text of %d chars for memory formation", len(ai_response))

            # Step 1 & 2: Semantic change-based segmentation
            events, sentence_embeddings = self.segmenter.segment_text_into_events(
                ai_response, self.embedding_provider
            )
            if not events:
                return []

            # Step 3: Boundary refinement
            if self.config.use_boundary_refinement and sentence_embeddings is not None:
                events = self.boundary_refiner.refine_boundaries(
                    events, context_vectors=sentence_embeddings, attention_keys=None
                )

            # Step 4 & 5: Common post-processing and memory storage
            final_events = await self._finalize_and_store_events(events)

            logger.info(
                "Created %d episodic events from conversation turn via semantic segmentation.",
                len(final_events),
            )
            return final_events

        except Exception as e:
            logger.error("EM-LLM memory formation failed: %s", e, exc_info=True)
            return []

    def _select_representative_tokens(self, event: EpisodicEvent) -> list[int]:
        """
        Select representative tokens within event (highest surprise scores).

        Args:
            event: Episodic event

        Returns:
            List of token indices (sorted)
        """
        if not event.surprise_scores:
            return []

        indexed_scores = [(score, i) for i, score in enumerate(event.surprise_scores)]
        indexed_scores.sort(key=lambda x: x[0], reverse=True)
        representative_indices = [i for _, i in indexed_scores[: self.config.repr_topk]]
        return sorted(representative_indices)

    def retrieve_relevant_memories_for_query(self, query: str) -> list[dict]:
        """
        Retrieve relevant memories using EM-LLM two-stage retrieval.

        Args:
            query: Query string

        Returns:
            List of memory entries (compatible with existing system)
        """
        logger.info("Retrieving memories using EM-LLM two-stage retrieval")

        try:
            if not self.embedding_provider:
                logger.warning("No embedding provider available for retrieval")
                return []

            # Execute EM-LLM two-stage retrieval
            query_embedding = np.array(self.embedding_provider.encode([query])[0])
            relevant_events = self.retrieval_system.retrieve_relevant_events(query_embedding)

            # Convert to dictionary format for compatibility with existing system
            memory_entries = []
            for i, event in enumerate(relevant_events):
                surprise_scores = event.surprise_scores or []
                surprise_mean = float(np.mean(surprise_scores)) if surprise_scores else 0.0
                surprise_max = float(np.max(surprise_scores)) if surprise_scores else 0.0
                event_size = len(event.tokens)

                memory_entry = {
                    "id": f"em_event_{event.start_position}_{event.end_position}",
                    "content": " ".join(event.tokens),
                    "summary": event.summary
                    or f"Episodic event from position {event.start_position} to {event.end_position}",
                    "surprise_stats": {
                        "mean_surprise": surprise_mean,
                        "max_surprise": surprise_max,
                        "event_size": event_size,
                    },
                    "representative_tokens": event.representative_tokens or [],
                    "retrieval_rank": i + 1,
                }
                memory_entries.append(memory_entry)

            logger.info("Retrieved %d EM-LLM memories", len(memory_entries))
            return memory_entries

        except AttributeError as e:
            logger.error(
                "EM-LLM memory retrieval failed due to missing component (e.g., embedding_provider): %s",
                e,
                exc_info=True,
            )
            return []
        except Exception as e:
            logger.error(
                "An unexpected error occurred during EM-LLM memory retrieval: %s", e, exc_info=True
            )
            return []

    def get_memory_statistics(self) -> dict:
        """
        Get current statistics of EM-LLM memory system.

        Returns:
            Dictionary with memory statistics
        """
        try:
            total_events = self.memory_system.count()

            stats = {
                "total_events": total_events,
                "configuration": {
                    "surprise_gamma": self.config.surprise_gamma,
                    "min_event_size": self.config.min_event_size,
                    "max_event_size": self.config.max_event_size,
                    "total_retrieved_events": self.config.total_retrieved_events,
                },
                "llm_config": self.get_current_llm_config_for_diagnostics(),
            }
            return stats
        except Exception as e:
            logger.error("Failed to get memory statistics: %s", e, exc_info=True)
            return {"status": "Error retrieving statistics", "error": str(e)}
