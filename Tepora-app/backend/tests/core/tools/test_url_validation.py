"""Tests for URL validation security in WebFetchTool."""


class TestWebFetchUrlValidation:
    """Test URL validation logic in WebFetchTool."""

    def test_localhost_blocked(self):
        """Test that localhost URLs are blocked."""
        from src.core.tools.native import WebFetchTool

        tool = WebFetchTool()
        result = tool._validate_url("http://localhost:3000/api")

        assert result is not None
        assert "blocked" in result.lower() or "error" in result.lower()

    def test_127_0_0_1_blocked(self):
        """Test that 127.0.0.1 URLs are blocked."""
        from src.core.tools.native import WebFetchTool

        tool = WebFetchTool()
        result = tool._validate_url("http://127.0.0.1:8080/test")

        assert result is not None
        assert "blocked" in result.lower() or "private" in result.lower()

    def test_private_192_168_blocked(self):
        """Test that 192.168.x.x URLs are blocked."""
        from src.core.tools.native import WebFetchTool

        tool = WebFetchTool()
        result = tool._validate_url("http://192.168.1.1/admin")

        assert result is not None
        assert "blocked" in result.lower() or "private" in result.lower()

    def test_private_10_x_blocked(self):
        """Test that 10.x.x.x URLs are blocked."""
        from src.core.tools.native import WebFetchTool

        tool = WebFetchTool()
        result = tool._validate_url("http://10.0.0.1/internal")

        assert result is not None
        assert "blocked" in result.lower() or "private" in result.lower()

    def test_public_url_allowed(self):
        """Test that public URLs are allowed."""
        from src.core.tools.native import WebFetchTool

        tool = WebFetchTool()
        result = tool._validate_url("https://www.google.com")

        assert result is None  # No error = allowed

    def test_https_required(self):
        """Test that invalid schemes are rejected."""
        from src.core.tools.native import WebFetchTool

        tool = WebFetchTool()
        result = tool._validate_url("ftp://example.com/file")

        assert result is not None
        assert "http" in result.lower() or "scheme" in result.lower()

    def test_missing_host_rejected(self):
        """Test that URLs without host are rejected."""
        from src.core.tools.native import WebFetchTool

        tool = WebFetchTool()
        result = tool._validate_url("http://")

        assert result is not None

    def test_ipv6_literal_blocked(self):
        """Test that IPv6 literal URLs are blocked."""
        from src.core.tools.native import WebFetchTool

        tool = WebFetchTool()
        # [::1] is IPv6 localhost
        result = tool._validate_url("http://[::1]:8080/test")

        assert result is not None
        assert "blocked" in result.lower()

    def test_ipv6_private_blocked(self):
        """Test that private IPv6 URLs are blocked."""
        from src.core.tools.native import WebFetchTool

        tool = WebFetchTool()
        # fc00::/7 is unique local address (private)
        result = tool._validate_url("http://[fc00::1]/test")

        assert result is not None
        assert "blocked" in result.lower()
