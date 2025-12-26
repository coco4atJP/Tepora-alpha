"""
Model Manager - GGUFモデルの管理

機能:
- HuggingFace Hubからダウンロード
- ローカルファイルの追加（選択/D&D）
- モデル情報の取得
- アクティブモデルの管理
"""

import asyncio
import json
import logging
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from .types import (
    DownloadResult,
    DownloadStatus,
    ModelInfo,
    ModelRegistry,
    ModelRole,
    ProgressCallback,
    ProgressEvent,
)

logger = logging.getLogger(__name__)


# HuggingFace Hub は遅延インポート（依存関係の問題を避けるため）
def _get_hf_hub():
    try:
        from huggingface_hub import hf_hub_download, HfApi
        return hf_hub_download, HfApi
    except ImportError:
        logger.error("huggingface_hub is not installed. Run: pip install huggingface_hub")
        return None, None


class ModelManager:
    """
    GGUFモデルの管理
    
    - HuggingFace Hubからダウンロード
    - ローカルファイルの追加
    - モデル情報の取得
    """
    
    REGISTRY_FILENAME = "registry.json"
    
    def __init__(self, models_dir: Path):
        """
        Args:
            models_dir: モデルを保存するディレクトリ (e.g., %LOCALAPPDATA%/Tepora/models)
        """
        self.models_dir = models_dir
        self._registry: Optional[ModelRegistry] = None
        self._progress_callbacks: List[ProgressCallback] = []
        
    def _ensure_dirs(self) -> None:
        """必要なディレクトリを作成"""
        for role in ModelRole:
            (self.models_dir / role.value).mkdir(parents=True, exist_ok=True)
    
    def _get_registry_path(self) -> Path:
        return self.models_dir / self.REGISTRY_FILENAME
    
    def _load_registry(self) -> ModelRegistry:
        """レジストリをロード"""
        registry_path = self._get_registry_path()
        if registry_path.exists():
            try:
                with open(registry_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    models = []
                    for m in data.get("models", []):
                        models.append(ModelInfo(
                            id=m["id"],
                            display_name=m["display_name"],
                            role=ModelRole(m["role"]),
                            file_path=Path(m["file_path"]),
                            file_size=m["file_size"],
                            source=m["source"],
                            repo_id=m.get("repo_id"),
                            filename=m.get("filename"),
                            is_active=m.get("is_active", False),
                            added_at=datetime.fromisoformat(m["added_at"]) if m.get("added_at") else None,
                        ))
                    return ModelRegistry(
                        version=data.get("version", 1),
                        models=models,
                        active=data.get("active", {}),
                    )
            except Exception as e:
                logger.warning(f"Failed to load model registry: {e}")
        return ModelRegistry()
    
    def _save_registry(self, registry: ModelRegistry) -> None:
        """レジストリを保存"""
        self._ensure_dirs()
        registry_path = self._get_registry_path()
        data = {
            "version": registry.version,
            "models": [
                {
                    "id": m.id,
                    "display_name": m.display_name,
                    "role": m.role.value,
                    "file_path": str(m.file_path),
                    "file_size": m.file_size,
                    "source": m.source,
                    "repo_id": m.repo_id,
                    "filename": m.filename,
                    "is_active": m.is_active,
                    "added_at": m.added_at.isoformat() if m.added_at else None,
                }
                for m in registry.models
            ],
            "active": registry.active,
        }
        with open(registry_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    
    @property
    def registry(self) -> ModelRegistry:
        if self._registry is None:
            self._registry = self._load_registry()
        return self._registry
    
    def on_progress(self, callback: ProgressCallback) -> None:
        """進捗コールバックを登録"""
        self._progress_callbacks.append(callback)
    
    async def _emit_progress_async(self, event: ProgressEvent) -> None:
        """非同期コンテキストから呼ばれる進捗通知"""
        self._emit_progress(event)

    def _emit_progress(self, event: ProgressEvent) -> None:
        """進捗イベントを発火"""
        for callback in self._progress_callbacks:
            try:
                if asyncio.iscoroutinefunction(callback):
                    # コールバックが非同期関数の場合は、現在のループでタスクとして実行
                    # 注意: ここは同期関数なので、create_taskはループが走っている前提
                    asyncio.create_task(callback(event))
                else:
                    callback(event)
            except Exception as e:
                logger.warning(f"Progress callback error: {e}")
    
    def _generate_model_id(self, display_name: str) -> str:
        """モデルIDを生成"""
        # 表示名をスラッグ化し、衝突を避けるためにUUIDの一部を追加
        base = display_name.lower().replace(" ", "-").replace(".", "-")
        short_uuid = uuid.uuid4().hex[:8]
        return f"{base}-{short_uuid}"
    
    async def download_from_huggingface(
        self,
        repo_id: str,
        filename: str,
        role: ModelRole,
        display_name: Optional[str] = None,
    ) -> DownloadResult:
        """
        HuggingFace Hubからモデルをダウンロード
        
        Args:
            repo_id: HuggingFace repo (e.g., "unsloth/gemma-3n-E4B-it-GGUF")
            filename: ファイル名 (e.g., "gemma-3n-E4B-it-IQ4_XS.gguf")
            role: モデルの役割
            display_name: 表示名 (省略時はファイル名から生成)
        """
        self._ensure_dirs()
        
        if display_name is None:
            display_name = filename.replace(".gguf", "").replace("-", " ").title()

        try:
            from huggingface_hub import hf_hub_url
            import requests
            
            self._emit_progress(ProgressEvent(
                status=DownloadStatus.PENDING,
                progress=0.0,
                message=f"モデル情報を取得中: {repo_id}",
            ))
            
            # URLを取得
            url = hf_hub_url(repo_id, filename)
            
            # ダウンロード先
            target_dir = self.models_dir / role.value
            self._ensure_dirs()
            target_path = target_dir / filename
            
            # 部分的なダウンロード用の一時ファイル
            temp_path = target_path.with_suffix(".tmp")
            
            # ストリーミングダウンロードを実行
            loop = asyncio.get_event_loop()
            
            def download_file():
                headers = {}
                downloaded = 0
                
                # 既存の一時ファイルがあればレジュームを試みる
                if temp_path.exists():
                    downloaded = temp_path.stat().st_size
                    headers["Range"] = f"bytes={downloaded}-"
                
                with requests.get(url, stream=True, headers=headers) as response:
                    response.raise_for_status()
                    
                    total_size = int(response.headers.get('content-length', 0)) + downloaded
                    
                    mode = "ab" if downloaded > 0 else "wb"
                    with open(temp_path, mode) as f:
                        for chunk in response.iter_content(chunk_size=8192):
                            if chunk:
                                f.write(chunk)
                                downloaded += len(chunk)
                                
                                # 進捗コールバック（非同期イベントループにスケジュール）
                                if total_size > 0:
                                    progress = downloaded / total_size
                                    # 注意: ここは同期コンテキストなので、外部からポーリングされる変数などを更新するか
                                    # あるいはスレッドセーフな方法でイベントを送る必要がある
                                    # 簡易的に、DownloadManager側で定期的にファイルサイズをチェックするか、
                                    # ここでは非同期コールバックを直接呼び出せないので、
                                    # シンプルに実装するためにブロッキング呼び出しの中で進捗を計算し
                                    # 戻り値として返すことはできない。
                                    # run_in_executorを使うため、ここでasyncio.run_coroutine_threadsafeを使う
                                    asyncio.run_coroutine_threadsafe(
                                        self._emit_progress_async(ProgressEvent(
                                            status=DownloadStatus.DOWNLOADING,
                                            progress=progress,
                                            message=f"ダウンロード中: {filename} ({downloaded / 1024 / 1024:.1f}MB / {total_size / 1024 / 1024:.1f}MB)",
                                            total_bytes=total_size,
                                            current_bytes=downloaded
                                        )),
                                        loop
                                    )
                
                # 完了したらリネーム
                if temp_path.exists():
                    shutil.move(temp_path, target_path)
                
                return target_path

            await loop.run_in_executor(None, download_file)
            
            downloaded_path = target_path
            actual_size = downloaded_path.stat().st_size if downloaded_path.exists() else 0
            
            # レジストリに追加
            model_id = self._generate_model_id(display_name)
            model_info = ModelInfo(
                id=model_id,
                display_name=display_name,
                role=role,
                file_path=downloaded_path,
                file_size=actual_size,
                source="huggingface",
                repo_id=repo_id,
                filename=filename,
                is_active=False,
                added_at=datetime.now(),
            )
            
            self._registry = self.registry
            self._registry.models.append(model_info)
            
            # このロールにアクティブなモデルがなければ、これをアクティブに
            if role.value not in self._registry.active:
                self._registry.active[role.value] = model_id
                model_info.is_active = True
            
            self._save_registry(self._registry)
            
            self._emit_progress(ProgressEvent(
                status=DownloadStatus.COMPLETED,
                progress=1.0,
                message="ダウンロード完了",
            ))
            
            return DownloadResult(
                success=True,
                path=downloaded_path,
            )
            
        except Exception as e:
            logger.error(f"Failed to download model: {e}", exc_info=True)
            self._emit_progress(ProgressEvent(
                status=DownloadStatus.FAILED,
                progress=0.0,
                message=f"エラー: {str(e)}",
            ))
            return DownloadResult(
                success=False,
                error_message=str(e),
            )
    
    async def add_local_model(
        self,
        file_path: Path,
        role: ModelRole,
        display_name: str,
        copy_to_models_dir: bool = True,
    ) -> bool:
        """
        ローカルのGGUFファイルを追加（ファイル選択またはドラッグ&ドロップ）
        
        Args:
            file_path: GGUFファイルのパス
            role: モデルの役割
            display_name: 表示名
            copy_to_models_dir: Trueの場合コピー、Falseの場合は元のパスを参照
        """
        self._ensure_dirs()
        
        if not file_path.exists():
            logger.error(f"File not found: {file_path}")
            return False
        
        if not file_path.suffix.lower() == ".gguf":
            logger.error(f"Not a GGUF file: {file_path}")
            return False
        
        try:
            target_path = file_path
            
            if copy_to_models_dir:
                target_dir = self.models_dir / role.value
                target_path = target_dir / file_path.name
                
                if target_path.exists() and target_path != file_path:
                    # 既に存在する場合は上書き確認（ここではスキップ）
                    logger.warning(f"File already exists: {target_path}")
                else:
                    shutil.copy2(file_path, target_path)
            
            file_size = target_path.stat().st_size
            
            # レジストリに追加
            model_id = self._generate_model_id(display_name)
            model_info = ModelInfo(
                id=model_id,
                display_name=display_name,
                role=role,
                file_path=target_path,
                file_size=file_size,
                source="local",
                is_active=False,
                added_at=datetime.now(),
            )
            
            self._registry = self.registry
            self._registry.models.append(model_info)
            
            # このロールにアクティブなモデルがなければ、これをアクティブに
            if role.value not in self._registry.active:
                self._registry.active[role.value] = model_id
                model_info.is_active = True
            
            self._save_registry(self._registry)
            
            logger.info(f"Added local model: {display_name} ({model_id})")
            return True
            
        except Exception as e:
            logger.error(f"Failed to add local model: {e}", exc_info=True)
            return False
    
    def get_available_models(self, role: Optional[ModelRole] = None) -> List[ModelInfo]:
        """利用可能なモデル一覧を取得"""
        models = self.registry.models
        if role:
            models = [m for m in models if m.role == role]
        return models
    
    def get_active_model(self, role: ModelRole) -> Optional[ModelInfo]:
        """現在アクティブなモデルを取得"""
        active_id = self.registry.active.get(role.value)
        if active_id:
            for m in self.registry.models:
                if m.id == active_id:
                    return m
        return None
    
    async def set_active_model(self, role: ModelRole, model_id: str) -> bool:
        """指定ロールのアクティブモデルを設定"""
        # モデルが存在するか確認
        found = False
        for m in self.registry.models:
            if m.id == model_id and m.role == role:
                found = True
                break
        
        if not found:
            logger.error(f"Model not found: {model_id}")
            return False
        
        # アクティブ状態を更新
        self._registry = self.registry
        self._registry.active[role.value] = model_id
        
        for m in self._registry.models:
            if m.role == role:
                m.is_active = (m.id == model_id)
        
        self._save_registry(self._registry)
        logger.info(f"Set active model for {role.value}: {model_id}")
        return True
    
    async def delete_model(self, model_id: str) -> bool:
        """モデルを削除"""
        self._registry = self.registry
        
        model_to_delete = None
        for m in self._registry.models:
            if m.id == model_id:
                model_to_delete = m
                break
        
        if not model_to_delete:
            logger.error(f"Model not found: {model_id}")
            return False
        
        # ファイルを削除（modelsディレクトリ内の場合のみ）
        if model_to_delete.file_path.is_relative_to(self.models_dir):
            try:
                model_to_delete.file_path.unlink()
            except Exception as e:
                logger.warning(f"Failed to delete model file: {e}")
        
        # レジストリから削除
        self._registry.models = [m for m in self._registry.models if m.id != model_id]
        
        # アクティブだった場合は解除
        role = model_to_delete.role
        if self._registry.active.get(role.value) == model_id:
            # 同じロールの別のモデルがあればそれをアクティブに
            alternatives = [m for m in self._registry.models if m.role == role]
            if alternatives:
                self._registry.active[role.value] = alternatives[0].id
                alternatives[0].is_active = True
            else:
                del self._registry.active[role.value]
        
        self._save_registry(self._registry)
        logger.info(f"Deleted model: {model_id}")
        return True
    
    def get_model_path(self, role: ModelRole) -> Optional[Path]:
        """指定ロールのアクティブモデルのパスを取得"""
        model = self.get_active_model(role)
        if model and model.file_path.exists():
            return model.file_path
        return None
    
    def has_required_models(self) -> bool:
        """必須モデル（character, executor, embedding）がすべて揃っているか"""
        for role in [ModelRole.CHARACTER, ModelRole.EXECUTOR, ModelRole.EMBEDDING]:
            if not self.get_active_model(role):
                return False
        return True
