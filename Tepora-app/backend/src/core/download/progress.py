"""
Download Progress Manager - ダウンロードジョブの状態管理

機能:
- ダウンロードジョブの状態を永続化
- 中断・再開のサポート
- 進捗イベントのブロードキャスト
"""

import asyncio
import json
import logging
import uuid
from datetime import datetime
from pathlib import Path

from .types import (
    DownloadJobState,
    DownloadStatus,
    ProgressCallback,
    ProgressEvent,
)

logger = logging.getLogger(__name__)


class DownloadProgressManager:
    """
    ダウンロードジョブの状態を管理し、永続化を提供

    - ジョブの作成、更新、完了/失敗
    - 中断されたジョブの検出と再開
    - WebSocket経由での進捗通知
    """

    STATE_FILENAME = "download_jobs.json"

    def __init__(self, state_dir: Path):
        """
        Args:
            state_dir: 状態ファイルを保存するディレクトリ
        """
        self.state_dir = state_dir
        self._jobs: dict[str, DownloadJobState] = {}
        self._callbacks: list[ProgressCallback] = []
        self._cancel_flags: dict[str, asyncio.Event] = {}
        self._pause_flags: dict[str, asyncio.Event] = {}
        self._load_state()

    def _get_state_path(self) -> Path:
        return self.state_dir / self.STATE_FILENAME

    def _load_state(self) -> None:
        """永続化された状態をロード"""
        state_path = self._get_state_path()
        if not state_path.exists():
            return

        try:
            with open(state_path, encoding="utf-8") as f:
                data = json.load(f)
                for job_data in data.get("jobs", []):
                    job = DownloadJobState(
                        job_id=job_data["job_id"],
                        status=DownloadStatus(job_data["status"]),
                        target_url=job_data["target_url"],
                        target_path=Path(job_data["target_path"]),
                        partial_path=Path(job_data["partial_path"]),
                        total_bytes=job_data.get("total_bytes", 0),
                        downloaded_bytes=job_data.get("downloaded_bytes", 0),
                        error_message=job_data.get("error_message"),
                        created_at=datetime.fromisoformat(job_data["created_at"])
                        if job_data.get("created_at")
                        else None,
                        updated_at=datetime.fromisoformat(job_data["updated_at"])
                        if job_data.get("updated_at")
                        else None,
                    )
                    # 中断/失敗したジョブのみ保持（完了したものは除外）
                    if job.status not in (DownloadStatus.COMPLETED, DownloadStatus.CANCELLED):
                        self._jobs[job.job_id] = job
        except Exception as e:
            logger.warning(f"Failed to load download state: {e}")

    def _save_state(self) -> None:
        """状態を永続化"""
        self.state_dir.mkdir(parents=True, exist_ok=True)
        state_path = self._get_state_path()

        jobs_data = []
        for job in self._jobs.values():
            jobs_data.append(
                {
                    "job_id": job.job_id,
                    "status": job.status.value,
                    "target_url": job.target_url,
                    "target_path": str(job.target_path),
                    "partial_path": str(job.partial_path),
                    "total_bytes": job.total_bytes,
                    "downloaded_bytes": job.downloaded_bytes,
                    "error_message": job.error_message,
                    "created_at": job.created_at.isoformat() if job.created_at else None,
                    "updated_at": job.updated_at.isoformat() if job.updated_at else None,
                }
            )

        with open(state_path, "w", encoding="utf-8") as f:
            json.dump({"jobs": jobs_data}, f, indent=2, ensure_ascii=False)

    def on_progress(self, callback: ProgressCallback) -> None:
        """進捗コールバックを登録"""
        self._callbacks.append(callback)

    def remove_callback(self, callback: ProgressCallback) -> None:
        """進捗コールバックを削除"""
        if callback in self._callbacks:
            self._callbacks.remove(callback)

    def _emit_progress(self, event: ProgressEvent) -> None:
        """進捗イベントを発火"""
        for callback in self._callbacks:
            try:
                callback(event)
            except Exception as e:
                logger.warning(f"Progress callback error: {e}")

    def create_job(
        self,
        target_url: str,
        target_path: Path,
        total_bytes: int = 0,
    ) -> DownloadJobState:
        """新しいダウンロードジョブを作成"""
        job_id = str(uuid.uuid4())
        partial_path = target_path.with_suffix(target_path.suffix + ".part")

        job = DownloadJobState(
            job_id=job_id,
            status=DownloadStatus.PENDING,
            target_url=target_url,
            target_path=target_path,
            partial_path=partial_path,
            total_bytes=total_bytes,
            downloaded_bytes=0,
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )

        self._jobs[job_id] = job
        self._cancel_flags[job_id] = asyncio.Event()
        self._pause_flags[job_id] = asyncio.Event()
        self._save_state()

        return job

    def get_job(self, job_id: str) -> DownloadJobState | None:
        """ジョブを取得"""
        return self._jobs.get(job_id)

    def get_incomplete_jobs(self) -> list[DownloadJobState]:
        """未完了のジョブ一覧を取得（再開候補）"""
        return [
            job
            for job in self._jobs.values()
            if job.status
            in (DownloadStatus.PAUSED, DownloadStatus.FAILED, DownloadStatus.DOWNLOADING)
            and job.partial_path.exists()
        ]

    def update_job_progress(
        self,
        job_id: str,
        downloaded_bytes: int,
        total_bytes: int,
        speed_bps: float = 0.0,
        eta_seconds: float = 0.0,
    ) -> None:
        """ジョブの進捗を更新"""
        job = self._jobs.get(job_id)
        if not job:
            return

        job.downloaded_bytes = downloaded_bytes
        job.total_bytes = total_bytes
        job.status = DownloadStatus.DOWNLOADING
        job.updated_at = datetime.now()

        progress = downloaded_bytes / total_bytes if total_bytes > 0 else 0

        self._emit_progress(
            ProgressEvent(
                status=DownloadStatus.DOWNLOADING,
                progress=progress,
                message=f"ダウンロード中: {downloaded_bytes // (1024 * 1024)}MB / {total_bytes // (1024 * 1024)}MB",
                job_id=job_id,
                current_bytes=downloaded_bytes,
                total_bytes=total_bytes,
                speed_bps=speed_bps,
                eta_seconds=eta_seconds,
            )
        )

        # 定期的に状態を永続化（頻繁すぎないように）
        # 実際の実装ではスロットリングが必要
        self._save_state()

    def complete_job(self, job_id: str) -> None:
        """ジョブを完了としてマーク"""
        job = self._jobs.get(job_id)
        if not job:
            return

        job.status = DownloadStatus.COMPLETED
        job.updated_at = datetime.now()

        # .part ファイルを最終ファイルにリネーム
        if job.partial_path.exists():
            job.partial_path.rename(job.target_path)

        self._emit_progress(
            ProgressEvent(
                status=DownloadStatus.COMPLETED,
                progress=1.0,
                message="ダウンロード完了",
                job_id=job_id,
            )
        )

        # 完了したジョブは状態から削除
        del self._jobs[job_id]
        self._save_state()

    def fail_job(self, job_id: str, error_message: str) -> None:
        """ジョブを失敗としてマーク"""
        job = self._jobs.get(job_id)
        if not job:
            return

        job.status = DownloadStatus.FAILED
        job.error_message = error_message
        job.updated_at = datetime.now()

        self._emit_progress(
            ProgressEvent(
                status=DownloadStatus.FAILED,
                progress=job.downloaded_bytes / job.total_bytes if job.total_bytes > 0 else 0,
                message=f"エラー: {error_message}",
                job_id=job_id,
            )
        )

        self._save_state()

    def pause_job(self, job_id: str) -> bool:
        """ジョブを一時停止"""
        job = self._jobs.get(job_id)
        if not job or job.status != DownloadStatus.DOWNLOADING:
            return False

        # 一時停止フラグをセット
        if job_id in self._pause_flags:
            self._pause_flags[job_id].set()

        job.status = DownloadStatus.PAUSED
        job.updated_at = datetime.now()

        self._emit_progress(
            ProgressEvent(
                status=DownloadStatus.PAUSED,
                progress=job.downloaded_bytes / job.total_bytes if job.total_bytes > 0 else 0,
                message="一時停止中",
                job_id=job_id,
            )
        )

        self._save_state()
        return True

    def cancel_job(self, job_id: str) -> bool:
        """ジョブをキャンセル"""
        job = self._jobs.get(job_id)
        if not job:
            return False

        # キャンセルフラグをセット
        if job_id in self._cancel_flags:
            self._cancel_flags[job_id].set()

        job.status = DownloadStatus.CANCELLED
        job.updated_at = datetime.now()

        # 一時ファイルを削除
        if job.partial_path.exists():
            try:
                job.partial_path.unlink()
            except Exception as e:
                logger.warning(f"Failed to delete partial file: {e}")

        self._emit_progress(
            ProgressEvent(
                status=DownloadStatus.CANCELLED,
                progress=0,
                message="キャンセルされました",
                job_id=job_id,
            )
        )

        # キャンセルされたジョブは状態から削除
        del self._jobs[job_id]
        self._save_state()
        return True

    def is_cancelled(self, job_id: str) -> bool:
        """ジョブがキャンセルされたかチェック"""
        flag = self._cancel_flags.get(job_id)
        return flag.is_set() if flag else False

    def is_paused(self, job_id: str) -> bool:
        """ジョブが一時停止されたかチェック"""
        flag = self._pause_flags.get(job_id)
        return flag.is_set() if flag else False

    def clear_pause_flag(self, job_id: str) -> None:
        """一時停止フラグをクリア（再開時に使用）"""
        if job_id in self._pause_flags:
            self._pause_flags[job_id].clear()
