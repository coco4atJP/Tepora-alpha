"""
Verify Thinking Mode (CoT) implementation.
"""

import asyncio
import logging

from src.core.app_v2 import TeporaApp

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("verify_thinking")


async def main():
    app = TeporaApp()
    await app.initialize()

    print("\n--- Testing Without Thinking Mode ---")
    async for event in app.process_user_request(
        "Why is the sky blue?", session_id="verify-1", thinking_mode=False
    ):
        if event["event"] == "on_chat_model_stream":
            print(event["data"]["chunk"].content, end="", flush=True)
        elif event["event"] == "on_chain_start":
            if event["name"] == "thinking":
                print("\n[Thinking Node Started] (Should NOT happen)")

    print("\n\n--- Testing With Thinking Mode ---")
    async for event in app.process_user_request(
        "Why is the sky blue?", session_id="verify-2", thinking_mode=True
    ):
        if event["event"] == "on_chain_start":
            if event["name"] == "thinking":
                print("\n[Thinking Node Started]")
        elif event["event"] == "on_chat_model_stream":
            print(event["data"]["chunk"].content, end="", flush=True)

    # Check if thought process was captured in history
    history = app.history_manager.get_history("verify-2")
    if history:
         print(f"\n[History Verified] {len(history)} messages found.")
    # We can't easily check internal state "thought_process" here without modifying return,
    # but we can check if the response seems reasoned or check logs.

    await app.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
