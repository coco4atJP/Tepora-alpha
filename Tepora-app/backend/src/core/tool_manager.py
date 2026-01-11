# agent_core/tool_manager.py
"""
ツール管理モジュール。

このモジュールは以下を担います:
- MCP(Server)接続設定の読み込みとクライアント初期化
- ネイティブツール(DuckDuckGoなど)・MCPツールの発見と登録
- 同期/非同期ツールの実行を単一のインターフェースで提供
- 非同期処理用に専用のイベントループをバックグラウンドスレッドで常駐

設計メモ:
- 非同期ツールは `asyncio` のイベントループで動作させ、同期コードからは
  `asyncio.run_coroutine_threadsafe` により安全に橋渡しします。
- ツール名の衝突を避けるため、MCPツールは「サーバー名_ツール名」に正規化します。
"""

import asyncio
import json
import logging
import threading
from collections.abc import Coroutine
from typing import Any, TypedDict

from langchain_core.tools import BaseTool

from . import config
from .tools.base import ToolProvider

logger = logging.getLogger(__name__)


class ToolResult(TypedDict):
    """ツールの実行結果を表す型"""

    success: bool
    output: Any
    error: str | None


class ToolManager:
    """
    MCPツールおよびネイティブツールを統合的に管理するクラス。

    責務:
    - 設定ファイルからMCP接続を構築し、ツールを発見
    - ネイティブツール(DuckDuckGo検索など)の準備
    - 同期/非同期に関わらず、ツール実行の統一APIを提供
    - バックグラウンドのイベントループを維持し、非同期ツールを安全に実行
    """

    def __init__(self, providers: list["ToolProvider"] = None):
        """コンストラクタ

        引数:
            providers: ツールを提供するToolProviderのリスト
        """
        self.providers = providers or []
        self.tools: list[BaseTool] = []
        self.tool_map: dict[str, BaseTool] = {}
        self._all_tools: list[BaseTool] = []

        self._profile_name = config.get_active_agent_profile_name()

        # 非同期処理専用のイベントループを作成し、
        # デーモンスレッドで永続的に回し続ける
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, daemon=True)
        self._thread.start()
        logger.info("Async task runner thread started.")

    # 同期コードから非同期関数を安全に呼び出すためのブリッジメソッド
    def _run_coroutine(self, coro: Coroutine) -> Any:
        """Execute async coroutine from sync code and wait for result."""
        # バックグラウンドのイベントループにコルーチンを送信し、現在のスレッドで待機
        # ここで result() を呼ぶのは「ループスレッド以外」からのみ安全。
        # ループスレッド内で待機するとデッドロックするため、wrapper は使わない。
        timeout = config.settings.app.tool_execution_timeout
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        try:
            return future.result(timeout=timeout)
        except TimeoutError:
            logger.error(f"Coroutine execution timed out after {timeout} seconds.")
            raise
        except Exception as e:
            # future.result() raises the exception from the coroutine
            raise e

    def _make_error_response(self, error_code: str, message: str, **kwargs: Any) -> str:
        """Create a structured error response for frontend translation."""
        response = {
            "error": True,
            "error_code": error_code,
            "message": message,
            **kwargs,
        }
        return json.dumps(response, ensure_ascii=False)

    # 同期/非同期を問わず、全てのツールを実行するための統一インターフェース
    def execute_tool(self, tool_name: str, tool_args: dict) -> str | Any:
        """
        指定されたツールを同期/非同期を自動で判断して実行する。
        graph.pyからはこのメソッドだけを呼び出せば良い。

        処理の流れ:
        1. ツール名でツールインスタンスを取得
        2. `aexecute_tool`をコルーチンとして取得
        3. バックグラウンドのイベントループで実行し、結果を待つ
        """
        try:
            # aexecute_toolは同期/非同期を内部で吸収してくれる
            # これを同期的に呼び出すだけで良い
            logger.info("Executing tool '%s' via sync bridge.", tool_name)
            coro = self.aexecute_tool(tool_name, tool_args)
            return self._run_coroutine(coro)
        except TimeoutError:
            logger.error(f"Tool '{tool_name}' execution timed out.")
            return self._make_error_response(
                "tool_timeout",
                f"Tool '{tool_name}' execution timed out.",
                tool_name=tool_name
            )
        except Exception as e:
            logger.error(f"Error executing tool {tool_name}: {e}", exc_info=True)
            return self._make_error_response(
                "tool_execution_error",
                f"Error executing tool {tool_name}: {e}",
                tool_name=tool_name,
                details=str(e)
            )

    async def aexecute_tool(self, tool_name: str, tool_args: dict) -> str | Any:
        """非同期コンテキストからツールを実行するためのヘルパー。"""
        tool_instance = self.get_tool(tool_name)
        if not tool_instance:
            # エラーメッセージもログに出力するとデバッグしやすい
            logger.error("Tool '%s' not found.", tool_name)
            return self._make_error_response(
                "tool_not_found",
                f"Tool '{tool_name}' not found.",
                tool_name=tool_name
            )

        try:
            if hasattr(tool_instance, "ainvoke"):
                logger.info("Executing ASYNC tool: %s", tool_name)
                return await tool_instance.ainvoke(tool_args)

            if hasattr(tool_instance, "invoke"):
                logger.info("Executing SYNC tool in executor: %s", tool_name)
                return await asyncio.to_thread(tool_instance.invoke, tool_args)

            return self._make_error_response(
                "tool_no_method",
                f"Tool '{tool_name}' has no callable invoke or ainvoke method.",
                tool_name=tool_name
            )
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "Error executing tool %s asynchronously: %s", tool_name, exc, exc_info=True
            )
            return self._make_error_response(
                "tool_execution_error",
                f"Error executing tool {tool_name}: {exc}",
                tool_name=tool_name,
                details=str(exc)
            )

    def initialize(self):
        """
        登録されたプロバイダからツールを初期化する。
        """
        logger.info("Initializing ToolManager...")
        # 1. ツールリストとマップを明示的にクリアし、再初期化の安全性を確保
        self.tools = []
        self.tool_map = {}
        self._all_tools = []

        # 2. 各プロバイダからツールをロード
        for provider in self.providers:
            try:
                logger.info("Loading tools from provider: %s", provider.__class__.__name__)
                # プロバイダのload_toolsはasyncなのでブリッジ経由で実行
                provider_tools = self._run_coroutine(provider.load_tools())
                self.tools.extend(provider_tools)
                logger.info(
                    f"Loaded {len(provider_tools)} tools from {provider.__class__.__name__}."
                )
            except Exception as e:
                logger.error(
                    f"An error occurred while loading tools from {provider.__class__.__name__}: {e}",
                    exc_info=True,
                )

        # 4. 全ツールリストを保持し、プロファイルでフィルタリング
        self._all_tools = list(self.tools)
        total_loaded = len(self._all_tools)
        self._apply_profile_filter()

        logger.info(
            "ToolManager initialized with %d tools (profile '%s', %d total loaded): %s",
            len(self.tools),
            self._profile_name,
            total_loaded,
            [t.name for t in self.tools],
        )

    def set_profile(self, profile_name: str) -> int:
        """Apply a new agent profile and refilter tools. Returns available count."""

        self._profile_name = profile_name
        if not self._all_tools:
            self.tools = []
            self.tool_map = {}
            return 0

        self._apply_profile_filter()
        logger.info(
            "Tool profile switched to '%s' (%d tools available)",
            self._profile_name,
            len(self.tools),
        )
        return len(self.tools)

    def _apply_profile_filter(self) -> None:
        """Filter the cached tool inventory according to the active profile."""

        filtered = config.filter_tools_for_profile(self._all_tools, self._profile_name)
        self.tools = list(filtered)
        self.tool_map = {tool.name: tool for tool in self.tools}

    def get_tool(self, tool_name: str) -> BaseTool | None:
        """指定された名前のツールを取得する。

        見つからない場合は `None` を返す。
        """
        return self.tool_map.get(tool_name)

    def cleanup(self):
        """リソースのクリーンアップ。

        - プロバイダのクリーンアップ
        - バックグラウンドイベントループを停止
        """
        # プロバイダのクリーンアップ
        for provider in self.providers:
            try:
                provider.cleanup()
            except Exception as e:
                logger.warning(f"Error during provider cleanup: {e}", exc_info=True)

        if self._loop.is_running():
            logger.info("Stopping async task runner thread...")
            try:
                shutdown_future = asyncio.run_coroutine_threadsafe(
                    self._loop.shutdown_asyncgens(), self._loop
                )
                shutdown_future.result(timeout=5)
            except Exception as e:
                logger.warning(
                    "Failed to shutdown async generators gracefully: %s", e, exc_info=True
                )

            self._loop.call_soon_threadsafe(self._loop.stop)
            self._thread.join(timeout=5)
            if self._thread.is_alive():
                logger.warning("Async runner thread did not stop gracefully.")
            else:
                logger.info("Async task runner thread stopped.")

        if not self._loop.is_closed():
            logger.debug("Closing async event loop.")
            self._loop.close()
