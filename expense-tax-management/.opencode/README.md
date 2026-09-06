# opencode Initialization for expense-tax-management

This directory contains project-specific rules and configurations for the opencode AI agent.

## Structure
- `rules/` - Domain-specific development rules
  - `expense-service.rules` - Python/FastAPI service conventions
  - `frontend.rules` - Next.js/Tailwind conventions

## Key Project Conventions (from AGENTS.md)
- **Multi-tenancy**: All queries scoped by `tenant_id`
- **LLM budget check**: Verify `tenant.llm_monthly_used < tenant.llm_monthly_budget` before API calls
- **API prefix**: `/api/v1/...` for all expense-service routes
- **Package managers**: `uv` (expense-service), `pnpm` (frontend)
- **Shared contracts**: Pydantic DTOs/enums live in `common/python/expense-contracts`; SQLAlchemy models remain service-owned
- **Linting**: `ruff check/format` for Python, `eslint` for frontend
- **Testing**: `pytest` for expense-service, component tests for frontend
- **Imports**: Absolute imports preferred (`from app.models.x import X`)
- **Async**: `async def` for all API endpoints and DB operations
- **Frontend**: Strictly presentation layer, no backend logic

## Usage
The opencode agent will automatically load rules from this directory and apply them to code suggestions, edits, and reviews.
