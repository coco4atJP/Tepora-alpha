import unittest

from src.core.a2a import A2AMessage, MessageType


class TestA2AProtocol(unittest.TestCase):
    def test_message_creation(self):
        msg = A2AMessage(
            type=MessageType.TASK,
            sender="agent_a",
            receiver="agent_b",
            content={"task": "do something"},
        )
        self.assertEqual(msg.type, MessageType.TASK)
        self.assertEqual(msg.sender, "agent_a")
        self.assertEqual(msg.receiver, "agent_b")
        self.assertEqual(msg.content["task"], "do something")
        self.assertIsNotNone(msg.id)
        self.assertIsNotNone(msg.timestamp)

    def test_serialization(self):
        msg = A2AMessage(
            type=MessageType.RESULT,
            sender="agent_b",
            receiver="agent_a",
            content={"result": "done"},
        )
        json_str = msg.to_json()
        restored_msg = A2AMessage.from_json(json_str)

        self.assertEqual(msg.id, restored_msg.id)
        self.assertEqual(msg.type, restored_msg.type)
        self.assertEqual(msg.content, restored_msg.content)

    def test_dict_conversion(self):
        msg = A2AMessage(
            type=MessageType.ERROR, sender="system", receiver="*", content={"error": "fail"}
        )
        d = msg.to_dict()
        restored_msg = A2AMessage.from_dict(d)

        self.assertEqual(msg.id, restored_msg.id)
        self.assertEqual(msg.type, restored_msg.type)


if __name__ == "__main__":
    unittest.main()
