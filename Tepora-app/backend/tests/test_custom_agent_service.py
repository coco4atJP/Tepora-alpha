
import pytest
from src.core.config.service import ConfigService

@pytest.fixture
def config_service(tmp_path):
    # Use temporary paths for testing
    config_path = tmp_path / "config.yml"
    secrets_path = tmp_path / "secrets.yaml"
    user_data_dir = tmp_path / "user_data"
    user_data_dir.mkdir()

    service = ConfigService(
        config_path=config_path,
        secrets_path=secrets_path,
        user_data_dir=user_data_dir
    )
    return service

def test_custom_agent_crud(config_service):
    # 1. Create
    agent_data = {
        "id": "test-agent",
        "name": "Test Agent",
        "system_prompt": "You are a test agent.",
        "enabled": True
    }
    success, result = config_service.create_custom_agent(agent_data)
    assert success is True
    assert isinstance(result, dict)
    assert result["id"] == "test-agent"
    assert result["created_at"] is not None

    # 2. Get
    agent = config_service.get_custom_agent("test-agent")
    assert agent is not None
    assert agent["name"] == "Test Agent"

    # 3. List
    agents = config_service.list_custom_agents()
    assert len(agents) == 1
    assert agents[0]["id"] == "test-agent"

    # 4. Update
    update_data = {"description": "Updated description"}
    success, result = config_service.update_custom_agent("test-agent", update_data)
    assert success is True
    assert result["description"] == "Updated description"
    assert result["updated_at"] > result["created_at"]

    # 5. Delete
    success, result = config_service.delete_custom_agent("test-agent")
    assert success is True

    agent = config_service.get_custom_agent("test-agent")
    assert agent is None
