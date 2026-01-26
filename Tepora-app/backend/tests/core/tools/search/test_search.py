
import pytest
from unittest.mock import MagicMock, patch, Mock
import json
from src.core.tools.search.base import SearchEngine, SearchResult
from src.core.tools.search.providers.google import GoogleSearchEngine
from src.core.tools.search.tool import SearchTool
from src.core.config.schema import PrivacyConfig

# Mock settings
@pytest.fixture
def mock_settings():
    with patch("src.core.tools.search.providers.google.settings") as mock:
        mock.tools.google_search_api_key.get_secret_value.return_value = "dummy_key"
        mock.tools.google_search_engine_id = "dummy_cx"
        mock.privacy.allow_web_search = True
        mock.privacy.redact_pii = False
        yield mock

class TestSearchEngine:
    def test_base_class(self):
        # Concrete implementation for testing abstract base class
        class TestEngine(SearchEngine):
            @property
            def name(self): return "test"
            def search(self, query, **kwargs): return []
            async def asearch(self, query, **kwargs): return []
        
        engine = TestEngine()
        assert engine.name == "test"
        assert engine.search("foo") == []

class TestGoogleSearchEngine:
    def test_search_success(self, mock_settings):
        engine = GoogleSearchEngine()
        
        # Mock requests
        with patch("src.core.tools.search.providers.google.requests.Session") as mock_session_cls:
            mock_session = mock_session_cls.return_value
            mock_session.__enter__.return_value = mock_session
            
            mock_response = Mock()
            mock_response.json.return_value = {
                "items": [
                    {"title": "Result 1", "link": "http://example.com/1", "snippet": "Snippet 1"},
                    {"title": "Result 2", "link": "http://example.com/2", "snippet": "Snippet 2"}
                ]
            }
            mock_session.get.return_value = mock_response
            
            results = engine.search("test query")
            
            assert len(results) == 2
            assert results[0].title == "Result 1"
            assert results[0].url == "http://example.com/1"
            assert results[0].snippet == "Snippet 1"
            
            # Verify API call parameters
            mock_session.get.assert_called_once()
            args, kwargs = mock_session.get.call_args
            assert kwargs["params"]["key"] == "dummy_key"
            assert kwargs["params"]["cx"] == "dummy_cx"
            assert kwargs["params"]["q"] == "test query"

    def test_search_api_error(self, mock_settings):
        engine = GoogleSearchEngine()
        
        with patch("src.core.tools.search.providers.google.requests.Session") as mock_session_cls:
            mock_session = mock_session_cls.return_value
            mock_session.__enter__.return_value = mock_session
            
            mock_response = Mock()
            mock_response.json.return_value = {
                "error": {
                    "code": 403,
                    "message": "Quota exceeded"
                }
            }
            mock_session.get.return_value = mock_response
            
            with pytest.raises(ValueError, match="Google API Error"):
                engine.search("test query")

class TestSearchTool:
    def test_run_success(self, mock_settings):
        # Mock engine
        mock_engine = MagicMock(spec=SearchEngine)
        mock_engine.name = "mock_engine"
        mock_engine.search.return_value = [
            SearchResult(title="T1", url="U1", snippet="S1")
        ]
        
        tool = SearchTool(
            engine=mock_engine,
            name="test_search",
            description="Test search tool"
        )
        
        # Mock settings for tool
        with patch("src.core.tools.search.tool.settings", mock_settings):
            result_json = tool._run("query")
            
            result = json.loads(result_json)
            assert result["total_results"] == 1
            assert result["results"][0]["title"] == "T1"
            assert result["engine"] == "mock_engine"
            
            mock_engine.search.assert_called_with("query")

    def test_privacy_disabled(self, mock_settings):
        mock_settings.privacy.allow_web_search = False
        
        tool = SearchTool(
            engine=MagicMock(spec=SearchEngine),
            name="test_search",
            description="Test search tool"
        )
        
        with patch("src.core.tools.search.tool.settings", mock_settings):
            result = tool._run("query")
            assert "disabled" in result

    def test_pii_redaction(self, mock_settings):
        mock_settings.privacy.redact_pii = True
        
        mock_engine = MagicMock(spec=SearchEngine)
        mock_engine.search.return_value = []
        
        tool = SearchTool(
            engine=mock_engine,
            name="test_search",
            description="Test search tool"
        )
        
        with patch("src.core.tools.search.tool.settings", mock_settings):
            # Mock pii_redactor
            with patch("src.core.tools.search.tool.redact_pii") as mock_redactor:
                mock_redactor.return_value = ("REDACTED query", 1)
                
                tool._run("my email is test@example.com")
                
                mock_redactor.assert_called()
                mock_engine.search.assert_called_with("REDACTED query")
