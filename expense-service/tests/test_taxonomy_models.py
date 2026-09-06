import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.category import Category
from app.models.project import Project
from app.models.tag import Tag
from app.models.tenant import Tenant


@pytest.mark.asyncio
async def test_create_category_and_tenant_isolation(db_session: AsyncSession) -> None:
    # 1. Create two tenants
    t1 = Tenant(name="Tenant A", slug="tenant-a")
    t2 = Tenant(name="Tenant B", slug="tenant-b")
    db_session.add_all([t1, t2])
    await db_session.commit()

    # 2. Add category "Travel" to Tenant A
    cat_a = Category(tenant_id=t1.id, name="Travel", color="#EF4444", icon="plane")
    # 3. Add category "Travel" to Tenant B (should succeed because tenant_id is different)
    cat_b = Category(tenant_id=t2.id, name="Travel", color="#3B82F6", icon="car")
    db_session.add_all([cat_a, cat_b])
    await db_session.commit()

    # Verify retrieval
    res_a = await db_session.execute(
        select(Category).where(Category.tenant_id == t1.id)
    )
    cats_a = res_a.scalars().all()
    assert len(cats_a) == 1
    assert cats_a[0].name == "Travel"
    assert cats_a[0].color == "#EF4444"

    res_b = await db_session.execute(
        select(Category).where(Category.tenant_id == t2.id)
    )
    cats_b = res_b.scalars().all()
    assert len(cats_b) == 1
    assert cats_b[0].name == "Travel"
    assert cats_b[0].color == "#3B82F6"


@pytest.mark.asyncio
async def test_category_unique_constraint_within_same_tenant(
    db_session: AsyncSession,
) -> None:
    t1 = Tenant(name="Tenant Unique", slug="tenant-unique")
    db_session.add(t1)
    await db_session.commit()

    cat1 = Category(tenant_id=t1.id, name="Supplies")
    cat2 = Category(tenant_id=t1.id, name="Supplies")
    db_session.add(cat1)
    await db_session.commit()

    db_session.add(cat2)
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_create_project_with_tax_fields(db_session: AsyncSession) -> None:
    t = Tenant(name="Consulting Inc", slug="consulting-inc")
    db_session.add(t)
    await db_session.commit()

    proj = Project(
        tenant_id=t.id,
        name="Client Alpha",
        business_type="LLC",
        tax_year=2025,
        color="#10B981",
        icon="briefcase",
    )
    db_session.add(proj)
    await db_session.commit()

    result = await db_session.execute(select(Project).where(Project.tenant_id == t.id))
    fetched = result.scalar_one()
    assert fetched.name == "Client Alpha"
    assert fetched.tax_year == 2025
    assert fetched.business_type == "LLC"
    assert fetched.is_active is True


@pytest.mark.asyncio
async def test_create_tag_and_usage(db_session: AsyncSession) -> None:
    t = Tenant(name="Tag Tenant", slug="tag-tenant")
    db_session.add(t)
    await db_session.commit()

    tag = Tag(tenant_id=t.id, name="urgent", is_auto_generated=False)
    db_session.add(tag)
    await db_session.commit()

    result = await db_session.execute(select(Tag).where(Tag.name == "urgent"))
    saved = result.scalar_one()
    assert saved.name == "urgent"
    assert saved.is_auto_generated is False
    assert saved.usage_count == 0


@pytest.mark.asyncio
async def test_seed_tenant_categories_idempotent(db_session: AsyncSession) -> None:
    from app.services.seed import DEFAULT_SYSTEM_CATEGORIES, seed_tenant_categories

    t = Tenant(name="Seed Tenant", slug="seed-tenant")
    db_session.add(t)
    await db_session.commit()

    # First run: should seed all default categories
    seeded_first = await seed_tenant_categories(db_session, t.id)
    assert len(seeded_first) == len(DEFAULT_SYSTEM_CATEGORIES)

    # Second run: should be idempotent and add 0 new categories
    seeded_second = await seed_tenant_categories(db_session, t.id)
    assert len(seeded_second) == 0

    # Verify all categories belong to tenant
    res = await db_session.execute(select(Category).where(Category.tenant_id == t.id))
    all_cats = res.scalars().all()
    assert len(all_cats) == len(DEFAULT_SYSTEM_CATEGORIES)
    for c in all_cats:
        assert c.is_system is True
