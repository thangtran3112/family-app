# Phase 1C — Gateway AuthN/AuthZ (Traefik ForwardAuth)

> **Milestone**: 1 (CI/CD, Deployment & API Gateway)
> **Dependencies**: Phase 1B (VPS Deployment with Traefik)
> **Estimated Effort**: 3 days

---

## Objective

Implement centralized authentication and authorization at the Traefik gateway layer, so all downstream microservices receive pre-validated identity headers (`X-User-Id`, `X-Tenant-Id`, `X-User-Role`, `X-User-Email`) without implementing auth logic themselves.

---

## Why Gateway-Level Auth

### The Problem with Per-Service Auth

In a traditional setup, every microservice must independently:
1. Parse the `Authorization: Bearer <JWT>` header
2. Validate the JWT signature (fetch JWKS keys, verify expiry, check issuer)
3. Extract claims (user ID, tenant ID, roles)
4. Enforce RBAC policies

This leads to:
- **Duplicated auth code** across every service (FastAPI, Temporal UI, future services)
- **Inconsistent enforcement** — one service might check roles, another might not
- **Tight coupling** to the auth provider — switching from self-hosted JWT to Auth0/Clerk requires touching every service
- **Performance overhead** — each service makes independent JWKS endpoint calls

### The Gateway Auth Pattern

```
Client (Browser/Mobile)
    │
    │  Authorization: Bearer <JWT>
    ▼
┌──────────────────────────────────────────────────────────────┐
│  Traefik Gateway                                             │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  ForwardAuth Middleware                                 │  │
│  │  ├─ Forwards request to Auth Service                   │  │
│  │  ├─ Auth Service validates JWT, returns identity headers│  │
│  │  ├─ Traefik OVERWRITES client headers with auth response│  │
│  │  └─ Strips original Authorization header (optional)     │  │
│  └────────────────────────────────────────────────────────┘  │
│                         │                                    │
│                         ▼                                    │
│  Propagated headers to ALL downstream services:              │
│  ├─ X-User-Id: "usr_abc123"                                 │
│  ├─ X-Tenant-Id: "tenant_xyz"                               │
│  ├─ X-User-Email: "user@example.com"                        │
│  ├─ X-User-Role: "owner"                                    │
│  └─ X-User-Name: "Toby Tran"                                │
└──────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────┐
│  Downstream Services (trust headers unconditionally)     │
│  ├─ FastAPI: reads X-User-Id, X-Tenant-Id from headers  │
│  ├─ Temporal UI: protected by ForwardAuth (no custom auth)│
│  └─ Future Service: automatically secured via gateway     │
└─────────────────────────────────────────────────────────┘
```

### Benefits

1. **Single Point of Auth Enforcement**: Add a new microservice to Docker Compose, apply the `auth-forward` middleware label — instant security with zero auth code.
2. **Auth Provider Agnostic**: Switch from self-hosted JWT to Auth0, Clerk, or Supabase Auth by changing only the Auth Service. No downstream changes.
3. **Consistent Identity**: Every service sees the same `X-User-Id` / `X-Tenant-Id` headers — no disagreements about identity parsing.
4. **Zero Trust Internal Network**: Even if the Docker network is compromised, services only trust gateway-injected headers (Traefik overwrites client-supplied values).

---

## Architecture

### Auth Service (`expense-service/app/api/v1/auth_verify.py`)

A lightweight FastAPI endpoint that Traefik calls on every request:

```python
from fastapi import APIRouter, Request, Response, HTTPException
import jwt  # PyJWT

router = APIRouter()

@router.get("/auth/verify")
async def verify_auth(request: Request):
    """
    Traefik ForwardAuth endpoint.
    Validates JWT and returns identity headers.
    
    Returns 200 + headers if valid.
    Returns 401 if invalid/missing token.
    """
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    
    token = auth_header.split(" ", 1)[1]
    
    try:
        payload = jwt.decode(
            token,
            key=settings.jwt_public_key,
            algorithms=["RS256"],
            audience=settings.jwt_audience,
            issuer=settings.jwt_issuer,
        )
    except jwt.InvalidTokenError as e:
        raise HTTPException(status_code=401, detail=str(e))
    
    # Return identity headers for Traefik to propagate
    return Response(
        status_code=200,
        headers={
            "X-User-Id": payload["sub"],
            "X-Tenant-Id": payload.get("tenant_id", ""),
            "X-User-Email": payload.get("email", ""),
            "X-User-Role": payload.get("role", "member"),
            "X-User-Name": payload.get("name", ""),
        },
    )
```

### Traefik Middleware Configuration

```yaml
# In docker-compose.prod.yml
services:
  fastapi:
    labels:
      # Define the ForwardAuth middleware
      - "traefik.http.middlewares.auth-forward.forwardauth.address=http://fastapi:8000/auth/verify"
      - "traefik.http.middlewares.auth-forward.forwardauth.authResponseHeaders=X-User-Id,X-Tenant-Id,X-User-Email,X-User-Role,X-User-Name"
      - "traefik.http.middlewares.auth-forward.forwardauth.trustForwardHeader=false"
      
      # Apply to API routes
      - "traefik.http.routers.api.middlewares=auth-forward@docker,rate-limit@docker"
```

### Security: Header Injection Prevention

Traefik's `authResponseHeaders` whitelist is secure by design:
- Only headers listed in `authResponseHeaders` are copied from the auth service response
- These headers **overwrite** any client-supplied headers of the same name
- Setting `trustForwardHeader=false` ensures the original `X-Forwarded-*` headers are stripped

This prevents the CVE-2026-30851 class of attacks that affects Caddy's `forward_auth`.

---

## Tasks

### 1. Auth Service Implementation

- [ ] Create `expense-service/app/api/v1/auth_verify.py` with `/auth/verify` endpoint
- [ ] JWT validation using `PyJWT` with RS256 asymmetric signing:
  - Generate RSA key pair for signing (store private key securely)
  - Distribute public key to auth verification endpoint
- [ ] Support both self-hosted JWT and future OAuth provider tokens
- [ ] Return 200 + identity headers on valid token
- [ ] Return 401 on invalid/expired/missing token
- [ ] Return 403 on valid token but insufficient permissions (optional)

### 2. JWT Token Issuance

- [ ] Create `POST /api/v1/auth/login` endpoint (email + password for MVP)
- [ ] Issue short-lived access tokens (15 min) + refresh tokens (7 days)
- [ ] Include claims: `sub` (user_id), `tenant_id`, `email`, `role`, `name`
- [ ] Store refresh tokens in `httpOnly` secure cookies (not localStorage)
- [ ] Create `POST /api/v1/auth/refresh` for token rotation
- [ ] Create `POST /api/v1/auth/logout` to invalidate refresh token

### 3. Traefik ForwardAuth Middleware

- [ ] Configure ForwardAuth middleware in `docker-compose.prod.yml`
- [ ] Apply to all API routes (`/api/*`)
- [ ] Exclude public routes from auth:
  - `POST /api/v1/auth/login`
  - `POST /api/v1/auth/register`
  - `POST /api/v1/auth/refresh`
  - `GET /api/v1/health`
- [ ] Configure route-specific middleware chains:
  ```yaml
  # Public routes (no auth)
  - "traefik.http.routers.api-public.rule=Host(`api.example.com`) && Path(`/api/v1/auth/login`)"
  - "traefik.http.routers.api-public.middlewares=rate-limit-strict@docker"
  
  # Protected routes (with auth)
  - "traefik.http.routers.api-protected.rule=Host(`api.example.com`) && PathPrefix(`/api`)"
  - "traefik.http.routers.api-protected.middlewares=auth-forward@docker,rate-limit@docker"
  ```

### 4. FastAPI Middleware: Read Gateway Headers

- [ ] Create `expense-service/app/core/gateway_auth.py`:
  ```python
  from fastapi import Request
  from dataclasses import dataclass

  @dataclass
  class GatewayIdentity:
      user_id: str
      tenant_id: str
      email: str
      role: str
      name: str

  def get_current_user(request: Request) -> GatewayIdentity:
      """Extract pre-validated identity from gateway headers."""
      return GatewayIdentity(
          user_id=request.headers.get("X-User-Id", ""),
          tenant_id=request.headers.get("X-Tenant-Id", ""),
          email=request.headers.get("X-User-Email", ""),
          role=request.headers.get("X-User-Role", "member"),
          name=request.headers.get("X-User-Name", ""),
      )
  ```
- [ ] Register as FastAPI dependency for protected routes
- [ ] All existing tenant-scoped queries use `identity.tenant_id` from headers

### 5. Rate Limiting Middleware

- [ ] Configure Traefik rate limiting per-IP:
  ```yaml
  - "traefik.http.middlewares.rate-limit.ratelimit.average=100"
  - "traefik.http.middlewares.rate-limit.ratelimit.burst=50"
  - "traefik.http.middlewares.rate-limit.ratelimit.period=1m"
  ```
- [ ] Stricter rate limiting for auth endpoints:
  ```yaml
  - "traefik.http.middlewares.rate-limit-strict.ratelimit.average=5"
  - "traefik.http.middlewares.rate-limit-strict.ratelimit.burst=3"
  - "traefik.http.middlewares.rate-limit-strict.ratelimit.period=1m"
  ```

### 6. User & Tenant Data Model (extend Phase 0B)

- [ ] Create `User` model if not already present:
  - `id`, `tenant_id`, `email`, `name`, `password_hash`, `role`
- [ ] Add `Tenant.owner_user_id` foreign key
- [ ] Alembic migration for user table
- [ ] Password hashing via `bcrypt` or `argon2`
- [ ] Create default admin user in seed script

---

## Public vs Protected Route Matrix

| Route | Auth Required | Rate Limit | Notes |
| :--- | :--- | :--- | :--- |
| `POST /api/v1/auth/login` | ❌ | Strict (5/min) | Token issuance |
| `POST /api/v1/auth/register` | ❌ | Strict (3/min) | New user signup |
| `POST /api/v1/auth/refresh` | ❌ (cookie-based) | Strict (10/min) | Token rotation |
| `GET /api/v1/health` | ❌ | None | Health check |
| `GET /api/v1/expenses/*` | ✅ | Standard (100/min) | Tenant-scoped |
| `POST /api/v1/expenses/upload` | ✅ | Standard (20/min) | File upload |
| `GET /api/v1/projects/*` | ✅ | Standard (100/min) | Tenant-scoped |
| `POST /api/v1/jobs/scan-gmail` | ✅ + Admin | Strict (1/hour) | Trigger Gmail scan |

---

## Future Extensibility

When new microservices are added to Docker Compose, securing them is a one-liner:

```yaml
services:
  new-analytics-service:
    image: analytics:latest
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.analytics.rule=Host(`api.example.com`) && PathPrefix(`/api/v1/analytics`)"
      - "traefik.http.routers.analytics.middlewares=auth-forward@docker"
      # That's it — the service receives X-User-Id, X-Tenant-Id headers automatically
```

No auth code needed in the new service. It simply reads the trusted gateway headers.

---

## Definition of Done

- [ ] JWT login/register/refresh endpoints working
- [ ] Traefik ForwardAuth validates JWT on every protected request
- [ ] Downstream services receive `X-User-Id`, `X-Tenant-Id`, `X-User-Role` headers
- [ ] Client-supplied identity headers are overwritten by gateway (no spoofing)
- [ ] Public routes (login, register, health) bypass auth
- [ ] Rate limiting active on all endpoints
- [ ] Adding a new service requires only Docker labels for auth (zero code)
