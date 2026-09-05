import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_register_and_login_flow(client: AsyncClient):
    # 1. Register new user
    register_payload = {
        "email": "toby@example.com",
        "password": "SecurePassword123!",
        "name": "Toby Tran",
        "tenant_name": "Family",
    }
    reg_res = await client.post("/api/v1/auth/register", json=register_payload)
    assert reg_res.status_code == 201, reg_res.text
    data = reg_res.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"
    assert data["user"]["email"] == "toby@example.com"
    assert data["tenant"]["name"] == "Family"
    assert data["tenant"]["slug"] == "family"

    token = data["access_token"]

    # 2. Login with registered credentials
    login_payload = {
        "email": "toby@example.com",
        "password": "SecurePassword123!",
    }
    login_res = await client.post("/api/v1/auth/login", json=login_payload)
    assert login_res.status_code == 200, login_res.text
    login_data = login_res.json()
    assert "access_token" in login_data

    # 3. Access /me with Bearer token
    me_res = await client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert me_res.status_code == 200, me_res.text
    me_data = me_res.json()
    assert me_data["user"]["email"] == "toby@example.com"
    assert me_data["tenant"]["name"] == "Family"


@pytest.mark.asyncio
async def test_duplicate_email_registration_fails(client: AsyncClient):
    payload = {
        "email": "duplicate@example.com",
        "password": "SecurePassword123!",
        "name": "First User",
    }
    res1 = await client.post("/api/v1/auth/register", json=payload)
    assert res1.status_code == 201

    res2 = await client.post("/api/v1/auth/register", json=payload)
    assert res2.status_code == 400
    assert "already exists" in res2.json()["detail"]
