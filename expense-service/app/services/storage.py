from __future__ import annotations

import logging
import os
from abc import ABC, abstractmethod

import aiofiles

logger = logging.getLogger(__name__)


class StorageAdapter(ABC):
    """Abstract storage adapter interface."""

    @abstractmethod
    async def upload(
        self,
        file_bytes: bytes,
        key: str,
        content_type: str,
        metadata: dict | None = None,
    ) -> str:
        """Upload file bytes to storage and return the storage key/path."""

    @abstractmethod
    async def download(self, key: str) -> bytes:
        """Download file bytes from storage using the key."""

    @abstractmethod
    def get_signed_url(self, key: str, expires_in_seconds: int = 3600) -> str:
        """Get a signed URL for secure file access with given expiry."""

    @abstractmethod
    async def delete(self, key: str) -> None:
        """Delete a file from storage."""


class LocalStorageAdapter(StorageAdapter):
    """Local filesystem storage adapter for offline development."""

    def __init__(self) -> None:
        self.base_dir = os.getenv("LOCAL_STORAGE_DIR", "/tmp/expense_tax_storage")
        os.makedirs(self.base_dir, exist_ok=True)

    async def upload(
        self,
        file_bytes: bytes,
        key: str,
        content_type: str,
        metadata: dict | None = None,
    ) -> str:
        """Upload to local filesystem directory: {base_dir}/{key}"""
        file_path = os.path.join(self.base_dir, key)
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        async with aiofiles.open(file_path, "wb") as f:
            await f.write(file_bytes)
        return file_path

    async def download(self, key: str) -> bytes:
        file_path = os.path.join(self.base_dir, key)
        async with aiofiles.open(file_path, "rb") as f:
            return await f.read()

    def get_signed_url(self, key: str, expires_in_seconds: int = 3600) -> str:
        file_path = os.path.join(self.base_dir, key)
        return f"file://{file_path}"

    async def delete(self, key: str) -> None:
        file_path = os.path.join(self.base_dir, key)
        if os.path.exists(file_path):
            async with aiofiles.open(file_path, "rb"):
                pass  # just check exists
            os.remove(file_path)


class GCSStorageAdapter(StorageAdapter):
    """Google Cloud Storage adapter using google-cloud-storage SDK."""

    def __init__(self) -> None:
        from google.cloud import storage

        self.client = storage.Client()
        self.bucket_name = os.getenv("GCS_BUCKET_NAME", "")
        self.bucket = self.client.bucket(self.bucket_name)

    async def upload(
        self,
        file_bytes: bytes,
        key: str,
        content_type: str,
        metadata: dict | None = None,
    ) -> str:
        """Upload to GCS: {bucket_name}/{key}"""
        blob = self.bucket.blob(key)
        blob.upload_from_string(
            file_bytes, content_type=content_type, metadata=metadata
        )
        return f"gs://{self.bucket_name}/{key}"

    async def download(self, key: str) -> bytes:
        blob = self.bucket.blob(key)
        return blob.download_as_bytes()

    def get_signed_url(self, key: str, expires_in_seconds: int = 3600) -> str:
        import datetime

        blob = self.bucket.blob(key)
        return blob.generate_signed_url(
            version="v4",
            expiration=datetime.timedelta(seconds=expires_in_seconds),
            method="GET",
        )

    async def delete(self, key: str) -> None:
        blob = self.bucket.blob(key)
        blob.delete()


def get_storage_adapter() -> StorageAdapter:
    """Factory function selecting adapter based on STORAGE_BACKEND env var."""
    backend = os.getenv("STORAGE_BACKEND", "local").lower()
    if backend == "gcs":
        return GCSStorageAdapter()
    return LocalStorageAdapter()
