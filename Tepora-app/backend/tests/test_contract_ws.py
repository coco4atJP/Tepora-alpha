from typing import Literal, Dict, Any, Optional, List
from pydantic import BaseModel, Field

# --- Schema Definitions ---

class ChunkMessage(BaseModel):
    type: Literal["chunk"]
    text: str
    is_structure: Optional[bool] = False

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
    results: List[Dict[str, Any]]
    query: Optional[str] = None

# Union type for all possible server messages
ServerMessage = ChunkMessage | DoneMessage | StatsMessage | ActivityMessage | SearchResultsMessage

def test_websocket_contract():
    """
    Validate that sample messages conform to the expected schema.
    This ensures that backend changes don't silently break frontend assumptions.
    """
    
    # 1. Chunk
    chunk_data = {"type": "chunk", "text": "Hello"}
    assert ChunkMessage(**chunk_data).text == "Hello"

    # 2. Done
    done_data = {"type": "done"}
    assert DoneMessage(**done_data).type == "done"

    # 3. Stats
    stats_data = {
        "type": "stats",
        "token_count": 100,
        "processing_time": 1.5,
        "model": "gpt-4"
    }
    stats = StatsMessage(**stats_data)
    assert stats.token_count == 100

    # 4. Activity
    activity_data = {"type": "activity", "content": "Thinking..."}
    assert ActivityMessage(**activity_data).content == "Thinking..."

    # 5. Search Results
    search_data = {
        "type": "search_results",
        "results": [{"title": "Test", "url": "http://example.com", "snippet": "content"}],
        "query": "test query"
    }
    results = SearchResultsMessage(**search_data)
    assert len(results.results) == 1
    assert results.results[0]["url"] == "http://example.com"
