import pytest

from src.core.mcp.installer import McpInstaller, extract_env_schema, generate_command
from src.core.mcp.models import EnvVarSchema, McpRegistryServer, PackageInfo


@pytest.fixture
def registry_server():
    return McpRegistryServer(
        id="test-server",
        name="Test Server",
        description="A test server",
        homepage="https://example.com",
        bugTracker="https://example.com/bugs",
        environmentVariables=[
            EnvVarSchema(name="API_KEY", description="API Key", isRequired=True, isSecret=True),
            EnvVarSchema(name="DEBUG", description="Debug mode", default="false"),
        ],
        packages=[
            PackageInfo(name="test-pkg", runtimeHint="npx"),
            PackageInfo(name="test-pkg-py", runtimeHint="uvx"),
        ],
    )


def test_normalize_server_key():
    assert McpInstaller.normalize_server_key("io.github.user/weather") == "weather"
    assert McpInstaller.normalize_server_key("simple-key") == "simple-key"
    assert McpInstaller.normalize_server_key("") == "mcp_server"
    assert McpInstaller.normalize_server_key(None) == "mcp_server"


def test_make_unique_key():
    existing = {"weather", "news"}
    assert McpInstaller.make_unique_key("music", existing) == "music"
    assert McpInstaller.make_unique_key("weather", existing) == "weather_2"

    existing.add("weather_2")
    assert McpInstaller.make_unique_key("weather", existing) == "weather_3"


def test_generate_config_defaults(registry_server):
    config = McpInstaller.generate_config(registry_server)

    assert config.command == "npx"
    assert config.args == ["-y", "test-pkg"]
    assert config.env["DEBUG"] == "false"
    assert "API_KEY" not in config.env  # No default, so not added if not provided


def test_generate_config_runtime_override(registry_server):
    config = McpInstaller.generate_config(registry_server, runtime="uvx")

    assert config.command == "uvx"
    assert config.args == ["test-pkg-py"]


def test_generate_config_with_env(registry_server):
    env_values = {"API_KEY": "secret123", "DEBUG": "true"}
    config = McpInstaller.generate_config(registry_server, env_values=env_values)

    assert config.env["API_KEY"] == "secret123"
    assert config.env["DEBUG"] == "true"


def test_generate_warnings():
    # Safe
    assert len(McpInstaller._generate_warnings("npx", ["create-react-app"])) > 0  # npx warning

    # Dangerous
    warnings = McpInstaller._generate_warnings("docker", ["run", "-v", "/:/host", "image"])
    assert any("Volume mount" in w for w in warnings)

    warnings = McpInstaller._generate_warnings("rm", ["-rf", "/"])
    assert any("Delete operation" in w for w in warnings)

    warnings = McpInstaller._generate_warnings("sudo", ["rm", "-rf", "/"])
    assert any("ROOT PRIVILEGES" in w for w in warnings)


def test_generate_consent_payload(registry_server):
    env_values = {"API_KEY": "secret123"}
    payload = McpInstaller.generate_consent_payload(registry_server, env_values=env_values)

    assert payload["server_name"] == "Test Server"
    assert payload["env"]["API_KEY"] == "***MASKED***"
    assert payload["requires_consent"] is True


def test_convenience_functions():
    # generate_command
    config = generate_command("npx", "my-pkg", {"FOO": "bar"})
    assert config.command == "npx"
    assert config.args == ["-y", "my-pkg"]
    assert config.env["FOO"] == "bar"

    # extract_env_schema
    data = {"environmentVariables": [{"name": "VAR1", "description": "Desc 1", "isRequired": True}]}
    schemas = extract_env_schema(data)
    assert len(schemas) == 1
    assert schemas[0].name == "VAR1"
    assert schemas[0].isRequired is True
