from __future__ import annotations

from pydantic import BaseModel, Field


class CategoryCreate(BaseModel):
    """Schema for creating a new category."""

    name: str = Field(..., min_length=1, max_length=100)
    description: str | None = Field(None, max_length=500)
    color: str = "#6B7280"
    icon: str = "tag"
    system_prompt: str | None = None
    is_system: bool = False


class CategoryResponse(BaseModel):
    """Schema for category response."""

    id: str
    name: str
    description: str | None = None
    color: str
    icon: str
    system_prompt: str | None = None
    is_system: bool
    created_at: str
    updated_at: str
    expenses_count: int = 0

    model_config = {"from_attributes": True}


class CategoryUpdate(BaseModel):
    """Schema for updating a category."""

    name: str | None = Field(None, min_length=1, max_length=100)
    description: str | None = Field(None, max_length=500)
    color: str | None = None
    icon: str | None = None
    system_prompt: str | None = None
    is_system: bool | None = None
