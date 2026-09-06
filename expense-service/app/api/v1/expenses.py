from __future__ import annotations

import io
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_tenant
from app.models.expense import Expense
from app.models.expense_file import ExpenseFile
from app.models.tenant import Tenant
from app.schemas.expense import ExpenseCreate, ExpenseResponse
from app.services.storage import StorageAdapter, get_storage_adapter

router = APIRouter(prefix="/expenses", tags=["expenses"])


@router.post("/", response_model=ExpenseResponse, status_code=status.HTTP_201_CREATED)
async def create_expense(
    expense_in: ExpenseCreate,
    db: AsyncSession = Depends(get_db),
    current_tenant: Tenant = Depends(get_current_tenant),
):
    """Create a new expense (manual entry)."""
    expense = Expense(
        tenant_id=current_tenant.id,
        user_id=expense_in.user_id,
        category_id=expense_in.category_id,
        project_id=expense_in.project_id,
        title=expense_in.title,
        description=expense_in.description,
        merchant=expense_in.merchant,
        amount=expense_in.amount,
        currency=expense_in.currency,
        date=expense_in.date,
        source=expense_in.source,
        tax_deduction_type=expense_in.tax_deduction_type,
        tax_deduction_percent=expense_in.tax_deduction_percent,
    )
    db.add(expense)
    await db.commit()
    await db.refresh(expense)
    return expense


@router.post("/{expense_id}/upload", status_code=status.HTTP_201_CREATED)
async def upload_expense_file(
    expense_id: uuid.UUID,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_tenant: Tenant = Depends(get_current_tenant),
):
    """Handle expense file upload: OCR, store to GCS/local, create ExpenseFile record."""
    # Get the expense to associate the file
    stmt = select(Expense).where(
        Expense.id == expense_id, Expense.tenant_id == current_tenant.id
    )
    result = await db.execute(stmt)
    expense = result.scalar_one_or_none()

    if not expense:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Expense not found",
        )

    # Read file bytes
    file_bytes = await file.read()
    filename = file.filename or "unknown"

    # Get storage adapter
    storage: StorageAdapter = get_storage_adapter()

    # Generate storage key: {tenantId}/{userId}/originals/{expenseId}/{filename}
    user_id = expense.user_id
    tenant_id = current_tenant.id
    storage_key = f"{tenant_id}/{user_id}/originals/{expense_id}/{filename}"

    # Upload original file to storage
    content_type = file.content_type or "application/octet-stream"
    storage_url = await storage.upload(file_bytes, storage_key, content_type)

    # Update or create ExpenseFile record
    # Check if file already exists
    stmt = select(ExpenseFile).where(ExpenseFile.expense_id == expense_id)
    result = await db.execute(stmt)
    existing_file = result.scalar_one_or_none()

    if existing_file:
        existing_file.cloud_storage_url = storage_url
        existing_file.cloud_storage_key = storage_key
        existing_file.original_filename = filename
        existing_file.mime_type = content_type
        existing_file.file_size = len(file_bytes)
        await db.commit()
        file_record = existing_file
    else:
        file_record = ExpenseFile(
            expense_id=expense_id,
            user_id=user_id,
            original_filename=filename,
            mime_type=content_type,
            file_size=len(file_bytes),
            local_path=None,  # No local temp file kept
            cloud_storage_url=storage_url,
            cloud_storage_key=storage_key,
            thumbnail_url=None,
            ocr_text=None,
        )
        db.add(file_record)
        await db.commit()
        await db.refresh(file_record)

    # Generate thumbnail (WebP, 300x300)
    try:
        from PIL import Image

        img = Image.open(io.BytesIO(file_bytes))
        # Convert to RGB if necessary (for PNG with transparency, etc.)
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        # Resize to 300x300 maintaining aspect ratio with white background
        img.thumbnail((300, 300), Image.Resampling.LANCZOS)

        thumb_buf = io.BytesIO()
        img.save(thumb_buf, format="WEBP", quality=80)
        thumb_bytes = thumb_buf.getvalue()

        # Upload thumbnail to GCS
        tenant_id_str = str(tenant_id)
        user_id_str = str(user_id)
        thumb_key = f"{tenant_id_str}/{user_id_str}/thumbnails/{expense_id}/{filename}_thumb.webp"
        thumb_storage_url = await storage.upload(thumb_bytes, thumb_key, "image/webp")

        # Update thumbnail URL on the file record
        file_record.thumbnail_url = thumb_storage_url

    except (ImportError, AttributeError, OSError) as e:
        # PIL not available or image processing failed - thumbnail generation skipped, file still uploaded
        import logging

        logger = logging.getLogger(__name__)
        logger.warning(f"Thumbnail generation failed: {e}")

    await db.commit()

    return {
        "id": file_record.id,
        "expense_id": file_record.expense_id,
        "original_filename": file_record.original_filename,
        "cloud_storage_url": file_record.cloud_storage_url,
        "cloud_storage_key": file_record.cloud_storage_key,
        "thumbnail_url": file_record.thumbnail_url,
        "ocr_text": file_record.ocr_text,
        "created_at": file_record.created_at,
    }
