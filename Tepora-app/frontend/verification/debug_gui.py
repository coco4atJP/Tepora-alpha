import json
from playwright.sync_api import sync_playwright, expect
import os

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={'width': 1280, 'height': 720}
        )

        # Grant permissions if needed
        context.grant_permissions(['clipboard-read', 'clipboard-write'])

        page = context.new_page()

        # Mock API calls to simulate a running backend
        def handle_config(route):
            route.fulfill(json={
                "app": {
                    "setup_completed": True,
                    "language": "en",
                    "nsfw_enabled": False,
                    "dangerous_patterns": [],
                    "max_input_length": 4000,
                    "graph_recursion_limit": 10,
                    "tool_execution_timeout": 60,
                    "tool_approval_timeout": 60,
                    "web_fetch_max_chars": 10000,
                    "mcp_config_path": "mcp_config.json"
                },
                "llm_manager": {
                    "process_terminate_timeout": 10,
                    "health_check_timeout": 5,
                    "health_check_interval": 30,
                    "tokenizer_model_key": "gpt-3.5-turbo",
                    "cache_size": 100
                },
                "chat_history": {
                    "max_tokens": 2000,
                    "default_limit": 50
                },
                "em_llm": {
                    "surprise_gamma": 0.1,
                    "min_event_size": 10,
                    "max_event_size": 100,
                    "total_retrieved_events": 5,
                    "repr_topk": 3,
                    "use_boundary_refinement": True
                },
                "privacy": {
                    "allow_web_search": True,
                    "redact_pii": False
                },
                "characters": {
                    "default": {
                        "name": "Tepora",
                        "description": "Your AI assistant",
                        "system_prompt": "You are a helpful assistant."
                    }
                },
                "active_agent_profile": "default",
                "models_gguf": {
                    "gpt-3.5-turbo": {
                        "path": "models/gpt-3.5-turbo",
                        "port": 8080,
                        "n_ctx": 4096,
                        "n_gpu_layers": 0
                    }
                },
                "tools": {
                    "search_provider": "google"
                },
                "custom_agents": {}
            })

        def handle_requirements(route):
            route.fulfill(json={
                "is_ready": True,
                "has_missing": False,
                "binary": {"status": "ok", "version": "1.0.0"},
                "models": {
                    "text": {"status": "ok", "name": "gpt-3.5-turbo"},
                    "embedding": {"status": "ok", "name": "text-embedding-ada-002"}
                }
            })

        def handle_models(route):
            route.fulfill(json={
                "models": [
                    {"id": "gpt-3.5-turbo", "name": "GPT 3.5 Turbo", "type": "llm", "loaded": True},
                ]
            })

        def handle_logs(route):
            route.fulfill(json={"logs": ["system.log", "error.log"]})

        def handle_log_content(route):
            route.fulfill(json={"content": "2023-10-27 10:00:00 [INFO] System started.\n2023-10-27 10:00:01 [INFO] Model loaded."})

        # Register mocks
        page.route("**/api/config", handle_config)
        page.route("**/api/setup/requirements", handle_requirements)
        page.route("**/api/models", handle_models)
        page.route("**/api/logs", handle_logs)
        page.route("**/api/logs/system.log", handle_log_content)

        try:
            # 1. Visit Home
            print("Navigating to Home...")
            page.goto("http://localhost:5173/")
            page.wait_for_load_state("networkidle")

            # Check for Setup Wizard and Skip if present (just in case)
            if page.get_by_text("Tepora Setup").is_visible():
                print("Setup Wizard detected. Clicking Skip...")
                skip_btn = page.get_by_role("button", name="Skip Setup")
                if skip_btn.is_visible():
                    skip_btn.click()
                else:
                    # Fallback for skip button locator
                    page.get_by_text("Skip Setup").click()
                page.wait_for_timeout(1000)

            # Check for Main Chat Interface
            try:
                # Expect the input area to be visible
                expect(page.get_by_role("textbox")).to_be_visible(timeout=10000)
                print("Home Page loaded.")
                page.screenshot(path="1_home.png")
            except Exception as e:
                print(f"Failed on Home Page: {e}")
                page.screenshot(path="error_home.png")

            # 2. Open Settings
            print("Navigating to Settings...")
            try:
                # Try multiple strategies to find the settings button
                settings_btn = page.get_by_role("button", name="Settings")
                if settings_btn.count() > 0 and settings_btn.first.is_visible():
                    settings_btn.first.click()
                else:
                    # Try finding by SVG class if accessible name is missing
                    # Note: Playwright selector for SVG inside button
                    page.locator("button:has(svg.lucide-settings)").first.click()

                # Wait for Modal
                settings_dialog = page.get_by_role("dialog")
                expect(settings_dialog).to_be_visible()

                # Check for header inside dialog
                # Use .first to avoid strict mode violation
                expect(settings_dialog.get_by_role("heading", name="Settings").first).to_be_visible()
                print("Settings Page loaded.")
                page.screenshot(path="2_settings.png")

                # Close settings
                page.keyboard.press("Escape")

            except Exception as e:
                print(f"Failed on Settings Page: {e}")
                page.screenshot(path="error_settings.png")

            # 3. Visit Logs Page (Standalone)
            print("Navigating to Logs Page...")
            try:
                page.goto("http://localhost:5173/logs")
                page.wait_for_load_state("networkidle")

                # Verify Sidebar list
                sidebar_item = page.get_by_role("button", name="system.log")
                expect(sidebar_item).to_be_visible()

                # Click it to load content
                sidebar_item.click()

                # Verify content loaded
                expect(page.get_by_text("System started")).to_be_visible()

                print("Logs Page verified.")
                page.screenshot(path="4_logs.png")

            except Exception as e:
                print(f"Failed on Logs Page: {e}")
                page.screenshot(path="error_logs_page.png")

        except Exception as e:
            print(f"Global Error: {e}")
        finally:
            browser.close()

if __name__ == "__main__":
    run()
