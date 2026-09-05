from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.category import Category

DEFAULT_SYSTEM_CATEGORIES = [
    {
        "name": "Advertising & Marketing",
        "description": "Online ads, marketing materials, and promotional expenses",
        "color": "#F59E0B",
        "icon": "megaphone",
        "system_prompt": "Classify expenses related to ads (Google, Meta), campaigns, SEO, PR, design work",
    },
    {
        "name": "Car & Truck Expenses",
        "description": "Gas, maintenance, insurance, and vehicle expenses for business",
        "color": "#3B82F6",
        "icon": "truck",
        "system_prompt": "Classify expenses related to gas stations, parking, auto repairs, oil changes",
    },
    {
        "name": "Office Supplies & Software",
        "description": "Stationery, computer peripherals, cloud SaaS, software tools",
        "color": "#10B981",
        "icon": "computer-desktop",
        "system_prompt": "Classify expenses related to Office Depot, Amazon supplies, software subscriptions",
    },
    {
        "name": "Travel & Lodging",
        "description": "Flights, hotels, trains, rideshare for business trips",
        "color": "#8B5CF6",
        "icon": "paper-airplane",
        "system_prompt": "Classify expenses related to airlines, hotels, Airbnb, Uber/Lyft trips",
    },
    {
        "name": "Meals & Client Dining",
        "description": "50% deductible business meals with clients, partners, or team members",
        "color": "#EF4444",
        "icon": "cake",
        "system_prompt": "Classify expenses related to restaurants, coffee shops, catering for business",
    },
    {
        "name": "Utilities & Communication",
        "description": "Internet, mobile phone, electricity for business premises",
        "color": "#06B6D4",
        "icon": "wifi",
        "system_prompt": "Classify telecom, ISP, mobile carrier, power bills",
    },
    {
        "name": "Legal & Professional Services",
        "description": "Accountant fees, legal counsel, consulting, bookkeeping",
        "color": "#6366F1",
        "icon": "briefcase",
        "system_prompt": "Classify CPA services, legal advice, consulting retainers",
    },
    {
        "name": "Other Deductible Expenses",
        "description": "General business expenses not covered elsewhere",
        "color": "#6B7280",
        "icon": "tag",
        "system_prompt": "Catch-all for legitimate ordinary business expenses",
    },
]


async def seed_tenant_categories(
    session: AsyncSession, tenant_id: uuid.UUID
) -> list[Category]:
    """Idempotently seed default system tax categories for a new or existing tenant."""
    seeded: list[Category] = []
    for cat_data in DEFAULT_SYSTEM_CATEGORIES:
        existing = await session.execute(
            select(Category).where(
                Category.tenant_id == tenant_id, Category.name == cat_data["name"]
            )
        )
        if existing.scalar_one_or_none() is None:
            category = Category(
                tenant_id=tenant_id,
                name=cat_data["name"],
                description=cat_data["description"],
                color=cat_data["color"],
                icon=cat_data["icon"],
                system_prompt=cat_data["system_prompt"],
                is_system=True,
            )
            session.add(category)
            seeded.append(category)

    if seeded:
        await session.commit()
    return seeded
