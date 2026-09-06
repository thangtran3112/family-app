from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import get_current_tenant
from app.models.expense import Expense
from app.models.project import Project
from app.models.tenant import Tenant
from app.schemas.project import ProjectCreate, ProjectResponse, ProjectUpdate

router = APIRouter(prefix="/projects", tags=["projects"])


@router.post("/", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_project(
    project_in: ProjectCreate,
    db: AsyncSession = Depends(get_db),
    current_tenant: Tenant = Depends(get_current_tenant),
):
    """Create a new project."""
    # Check if project name already exists for this tenant
    stmt = select(Project).where(
        Project.name == project_in.name, Project.tenant_id == current_tenant.id
    )
    result = await db.execute(stmt)
    existing = result.scalar_one_or_none()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A project with this name already exists",
        )

    project = Project(
        tenant_id=current_tenant.id,
        name=project_in.name,
        description=project_in.description,
        color=project_in.color,
        icon=project_in.icon,
        business_type=project_in.business_type,
        tax_year=project_in.tax_year,
        is_active=project_in.is_active,
        system_prompt=project_in.system_prompt,
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)

    # Count expenses for this project
    expense_stmt = select(Expense).where(Expense.project_id == project.id)
    expense_result = await db.execute(expense_stmt)
    expense_count = len(expense_result.scalars().all())

    return ProjectResponse(
        **{k: getattr(project, k) for k in ProjectResponse.model_fields},
        expenses_count=expense_count,
    )


@router.get("/", response_model=list[ProjectResponse])
async def list_projects(
    db: AsyncSession = Depends(get_db),
    current_tenant: Tenant = Depends(get_current_tenant),
):
    """List all projects for the current tenant."""
    stmt = select(Project).where(Project.tenant_id == current_tenant.id)
    result = await db.execute(stmt)
    projects = result.scalars().all()

    response = []
    for project in projects:
        expense_stmt = select(Expense).where(Expense.project_id == project.id)
        expense_result = await db.execute(expense_stmt)
        count = len(expense_result.scalars().all())

        project_dict = {k: getattr(project, k) for k in ProjectResponse.model_fields}
        project_dict["expenses_count"] = count
        response.append(ProjectResponse(**project_dict))

    return response


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_tenant: Tenant = Depends(get_current_tenant),
):
    """Get project details."""
    stmt = select(Project).where(
        Project.id == project_id, Project.tenant_id == current_tenant.id
    )
    result = await db.execute(stmt)
    project = result.scalar_one_or_none()

    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found",
        )

    expense_stmt = select(Expense).where(Expense.project_id == project.id)
    expense_result = await db.execute(expense_stmt)
    expense_count = len(expense_result.scalars().all())

    project_dict = {k: getattr(project, k) for k in ProjectResponse.model_fields}
    return ProjectResponse(**project_dict, expenses_count=expense_count)


@router.patch("/{project_id}", response_model=ProjectResponse)
async def update_project(
    project_id: uuid.UUID,
    project_in: ProjectUpdate,
    db: AsyncSession = Depends(get_db),
    current_tenant: Tenant = Depends(get_current_tenant),
):
    """Update a project."""
    stmt = select(Project).where(
        Project.id == project_id, Project.tenant_id == current_tenant.id
    )
    result = await db.execute(stmt)
    project = result.scalar_one_or_none()

    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found",
        )

    # Update only provided fields
    update_data = project_in.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(project, field, value)

    await db.commit()
    await db.refresh(project)

    expense_stmt = select(Expense).where(Expense.project_id == project.id)
    expense_result = await db.execute(expense_stmt)
    expense_count = len(expense_result.scalars().all())

    return ProjectResponse(
        **{k: getattr(project, k) for k in ProjectResponse.model_fields},
        expenses_count=expense_count,
    )


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_tenant: Tenant = Depends(get_current_tenant),
):
    """Soft-delete a project (set is_active to False)."""
    stmt = select(Project).where(
        Project.id == project_id, Project.tenant_id == current_tenant.id
    )
    result = await db.execute(stmt)
    project = result.scalar_one_or_none()

    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found",
        )

    project.is_active = False
    await db.commit()


@router.post("/{project_id}/tax-summary", response_model=dict)
async def get_tax_summary(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_tenant: Tenant = Depends(get_current_tenant),
):
    """Get tax deduction summary for a project."""
    # Check project exists and belongs to tenant
    stmt = select(Project).where(
        Project.id == project_id, Project.tenant_id == current_tenant.id
    )
    result = await db.execute(stmt)
    project = result.scalar_one_or_none()

    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found",
        )

    # Get expenses for this project
    expense_stmt = select(Expense).where(
        Expense.project_id == project_id, Expense.tenant_id == current_tenant.id
    )
    expense_result = await db.execute(expense_stmt)
    expenses = expense_result.scalars().all()

    from collections import defaultdict
    from decimal import Decimal

    # Calculate summaries
    category_totals: dict[str, Decimal] = defaultdict(lambda: Decimal(0))
    category_deductible: dict[str, Decimal] = defaultdict(lambda: Decimal(0))
    monthly_totals: dict[str, Decimal] = defaultdict(lambda: Decimal(0))
    monthly_deductible: dict[str, Decimal] = defaultdict(lambda: Decimal(0))
    total_expenses = Decimal(0)
    total_deductible = Decimal(0)

    for expense in expenses:
        amount = expense.amount or Decimal(0)
        ded_percent = expense.tax_deduction_percent or Decimal(0)
        is_deductible = expense.is_tax_deductible if expense.is_tax_deductible else True

        total_expenses += amount

        if is_deductible:
            total_deductible += amount
            category_totals[
                expense.category.name if expense.category else "Uncategorized"
            ] += amount
            category_deductible[
                expense.category.name if expense.category else "Uncategorized"
            ] += amount * ded_percent / Decimal(100)

        # Monthly breakdown
        if expense.date:
            month_key = expense.date.strftime("%Y-%m")
            monthly_totals[month_key] += amount
            if is_deductible:
                monthly_deductible[month_key] += amount * ded_percent / Decimal(100)

    # Build category summary
    category_summary = [
        {
            "category_name": cat,
            "total_amount": round(total, 2),
            "deductible_amount": round(deductible, 2),
            "expense_count": len(
                [
                    e
                    for e in expenses
                    if (e.category.name if e.category else "Uncategorized") == cat
                    and (e.is_tax_deductible if e.is_tax_deductible else True)
                ]
            ),
        }
        for cat, total in category_totals.items()
        for deductible in [category_deductible[cat]]
    ]

    # Build monthly summary
    monthly_summary = [
        {
            "month": month,
            "total_amount": round(total, 2),
            "deductible_amount": round(monthly_deductible[month], 2),
        }
        for month, total in sorted(monthly_totals.items())
    ]

    return {
        "project_id": str(project.id),
        "project_name": project.name,
        "tax_year": project.tax_year,
        "total_expenses": round(total_expenses, 2),
        "total_deductible": round(total_deductible, 2),
        "category_summary": category_summary,
        "monthly_summary": monthly_summary,
    }
