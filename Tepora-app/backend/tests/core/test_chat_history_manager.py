import sqlite3
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from src.core.chat_history_manager import ChatHistoryManager


@pytest.fixture
def db_path(tmp_path):
    return str(tmp_path / "test_chat.db")


@pytest.fixture
def chat_manager(db_path):
    return ChatHistoryManager(db_path=db_path)


def test_init_db(chat_manager, db_path):
    """Test database initialization."""
    with sqlite3.connect(db_path) as conn:
        cursor = conn.cursor()

        # Check sessions table
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
        assert cursor.fetchone() is not None

        # Check chat_history table
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_history'")
        assert cursor.fetchone() is not None

        # Check default session
        cursor.execute("SELECT * FROM sessions WHERE id='default'")
        assert cursor.fetchone() is not None


def test_add_get_message(chat_manager):
    """Test adding and retrieving messages."""
    msg = HumanMessage(content="Hello", additional_kwargs={"key": "value"})
    chat_manager.add_message(msg)

    history = chat_manager.get_history()
    assert len(history) == 1
    assert isinstance(history[0], HumanMessage)
    assert history[0].content == "Hello"
    assert history[0].additional_kwargs == {"key": "value"}


def test_message_types(chat_manager):
    """Test different message types."""
    messages = [
        SystemMessage(content="System"),
        HumanMessage(content="Human"),
        AIMessage(content="AI"),
        ToolMessage(content="Tool", tool_call_id="123"),
    ]

    chat_manager.add_messages(messages)
    history = chat_manager.get_history()

    assert len(history) == 4
    assert isinstance(history[0], SystemMessage)
    assert isinstance(history[1], HumanMessage)
    assert isinstance(history[2], AIMessage)
    assert isinstance(history[3], ToolMessage)
    assert history[3].tool_call_id == "123"


def test_create_delete_session(chat_manager):
    """Test creating and deleting sessions."""
    session_id = chat_manager.create_session(title="New Session")
    assert session_id is not None

    # Check session exists
    session = chat_manager.get_session(session_id)
    assert session is not None
    assert session["title"] == "New Session"

    # Add message to new session
    chat_manager.add_message(HumanMessage(content="Hi"), session_id=session_id)
    assert chat_manager.get_message_count(session_id) == 1

    # Delete session
    assert chat_manager.delete_session(session_id) is True

    # Verify deletion
    assert chat_manager.get_session(session_id) is None
    assert chat_manager.get_message_count(session_id) == 0


def test_list_sessions(chat_manager):
    """Test listing sessions."""
    session_id_1 = chat_manager.create_session(title="Session 1")
    session_id_2 = chat_manager.create_session(title="Session 2")

    sessions = chat_manager.list_sessions()

    # Should be at least 3 sessions (default + 2 created)
    assert len(sessions) >= 3

    session_ids = [s["id"] for s in sessions]
    assert session_id_1 in session_ids
    assert session_id_2 in session_ids
    assert "default" in session_ids


def test_clear_history(chat_manager):
    """Test clearing history."""
    chat_manager.add_message(HumanMessage(content="Hello"))
    assert chat_manager.get_message_count() == 1

    chat_manager.clear_history()
    assert chat_manager.get_message_count() == 0


def test_trim_history(chat_manager):
    """Test trimming history."""
    # Add 10 messages
    messages = [HumanMessage(content=f"msg {i}") for i in range(10)]
    chat_manager.add_messages(messages)

    assert chat_manager.get_message_count() == 10

    # Keep last 5
    chat_manager.trim_history(keep_last_n=5)

    history = chat_manager.get_history(limit=100)
    assert len(history) == 5
    assert history[0].content == "msg 5"
    assert history[-1].content == "msg 9"


def test_overwrite_history(chat_manager):
    """Test overwriting history."""
    chat_manager.add_message(HumanMessage(content="Old"))

    new_messages = [HumanMessage(content="New 1"), AIMessage(content="New 2")]

    chat_manager.overwrite_history(new_messages)

    history = chat_manager.get_history()
    assert len(history) == 2
    assert history[0].content == "New 1"
    assert history[1].content == "New 2"


def test_update_session_title(chat_manager):
    """Test updating session title."""
    session_id = chat_manager.create_session(title="Old Title")

    chat_manager.update_session_title(session_id, "New Title")

    session = chat_manager.get_session(session_id)
    assert session["title"] == "New Title"


def test_serialization_failure_handling(chat_manager):
    """Test handling of serialization failures."""

    # Create an object that fails JSON serialization
    class Unserializable:
        pass

    msg = HumanMessage(content="Fail", additional_kwargs={"bad": Unserializable()})

    # Should not raise exception, but log warning and use empty dict
    with patch("src.core.chat_history_manager.logger") as mock_logger:
        chat_manager.add_message(msg)
        # Verify it serialized with empty dict substitute
        history = chat_manager.get_history()
        assert history[0].content == "Fail"
