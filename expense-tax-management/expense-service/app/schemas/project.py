from __future__ import annotations

import datetime
from datetime import UTC

from pydantic import BaseModel, Field


class ProjectCreate(BaseModel):
    """Schema for creating a new project."""

    name: str = Field(..., min_length=1, max_length=100)
    description: str | None = Field(None, max_length=500)
    color: str = "#3B82F6"
    icon: str = "briefcase"
    business_type: str = "Sole Proprietorship"
    tax_year: int = Field(default_factory=lambda: datetime.datetime.now(UTC).year)
    is_active: bool = True
    system_prompt: str | None = None


class ProjectResponse(BaseModel):
    """Schema for project response."""

    id: str
    name: str
    description: str | None = None
    color: str
    icon: str
    business_type: str
    tax_year: int
    is_active: bool
    system_prompt: str | None = None
    created_at: str
    updated_at: str
    expenses_count: int = 0

    model_config = {"from_attributes": True}


class ProjectUpdate(BaseModel):
    """Schema for updating a project."""

    name: str | None = Field(None, min_length=1, max_length=100)
    description: str | None = Field(None, max_length=500)
    color: str | None = None
    icon: str | None = None
    business_type: str | None = None
    tax_year: int | None = None
    is_active: bool | None = None
    system_prompt: str | None = None
