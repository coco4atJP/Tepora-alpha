from typing import Any, Literal

from pydantic import BaseModel

# --- Schema Definitions ---


class ChunkMessage(BaseModel):
    type: Literal["chunk"]
    text: str
    is_structure: bool | None = False


class DoneMessage(BaseModel):
    type: Literal["done"]


class StatsMessage(BaseModel):
    type: Literal["stats"]
    token_count: int
    processing_time: float
    model: str


class ActivityMessage(BaseModel):
    type: Literal["activity"]
    content: str


class SearchResultsMessage(BaseModel):
    type: Literal["search_results"]
    results: list[dict[str, Any]]
    query: str | None = None


# Union type for all possible server messages
ServerMessage = ChunkMessage | DoneMessage | StatsMessage | ActivityMessage | SearchResultsMessage


def test_websocket_contract():
    """
    Validate that sample messages conform to the expected schema.
    This ensures that backend changes don't silently break frontend assumptions.
    """

    chunk_data = {"type": "chunk", "text": "Hello"}
    assert ChunkMessage(**chunk_data).text == "Hello"

    done_data = {"type": "done"}
    assert DoneMessage(**done_data).type == "done"

    stats_data = {"type": "stats", "token_count": 100, "processing_time": 1.5, "model": "gpt-4"}
    stats = StatsMessage(**stats_data)
    assert stats.token_count == 100

    activity_data = {"type": "activity", "content": "Thinking..."}
    assert ActivityMessage(**activity_data).content == "Thinking..."

    search_data = {
        "type": "search_results",
        "results": [{"title": "Test", "url": "http://example.com", "snippet": "content"}],
        "query": "test query",
    }
    results = SearchResultsMessage(**search_data)
    assert len(results.results) == 1
    assert results.results[0]["url"] == "http://example.com"
