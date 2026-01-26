import asyncio
import logging
import sys
from pathlib import Path

# Add backend to path
sys.path.append(str(Path(__file__).parents[2]))

from src.core.llm.ollama_runner import OllamaRunner
from src.core.llm.runner import RunnerConfig

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def main():
    print("--- Ollama Runner Verification ---")

    # Check if user provided model name
    model_name = sys.argv[1] if len(sys.argv) > 1 else "llama3"
    print(f"Target Model: {model_name}")

    runner = OllamaRunner()

    print("\n1. Starting (Verifying connectivity and model existence)...")
    try:
        port = await runner.start(RunnerConfig(model_key=model_name))
        print(f"✅ Success! Port: {port}")
    except RuntimeError as e:
        print(f"❌ Failed to start: {e}")
        print("Ensure Ollama is running and the model exists (try 'ollama list').")
        return

    print("\n2. Checking Status...")
    status = runner.get_status(model_name)
    print(f"Status: {status}")

    print("\n3. Stopping (Unloading)...")
    await runner.stop(model_name)
    print("✅ Unload request sent.")

    print("\nVerification Complete.")


if __name__ == "__main__":
    asyncio.run(main())
