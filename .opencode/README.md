# opencode Initialization for expense-tax-management

This directory contains project-specific rules and configurations for the opencode AI agent.

## Structure
- `rules/` - Domain-specific development rules
  - `backend.rules` - Python/FastAPI conventions
  - `frontend.rules` - Next.js/Tailwind conventions

## Key Project Conventions (from AGENTS.md)
- **Multi-tenancy**: All queries scoped by `tenant_id`
- **LLM budget check**: Verify `tenant.llm_monthly_used < tenant.llm_monthly_budget` before API calls
- **API prefix**: `/api/v1/...` for all backend routes
- **Package managers**: `uv` (backend), `pnpm` (frontend)
- **Linting**: `ruff check/format` for Python, `eslint` for frontend
- **Testing**: `pytest` for backend, component tests for frontend
- **Imports**: Absolute imports preferred (`from app.models.x import X`)
- **Async**: `async def` for all API endpoints and DB operations
- **Frontend**: Strictly presentation layer, no backend logic

## Usage
The opencode agent will automatically load rules from this directory and apply them to code suggestions, edits, and reviews.