from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    PROJECT_NAME: str = "Expense Tax Management API"
    VERSION: str = "0.1.0"
    API_V1_STR: str = "/api/v1"

    # Database (PostgreSQL 17 + pgvector)
    DATABASE_URL: str = (
        "postgresql+asyncpg://postgres:postgrespassword@localhost:5432/expense_tax_db"
    )

    # JWT Auth
    SECRET_KEY: str = "dev-secret-key-change-in-production-expense-tax-2026"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7  # 7 days

    # CORS
    CORS_ORIGINS: list[str] = [
        "http://localhost:7331",
        "http://localhost:3000",
        "http://127.0.0.1:7331",
        "http://127.0.0.1:3000",
    ]

    # Storage
    STORAGE_BACKEND: str = "local"  # "local" | "gcs"
    LOCAL_STORAGE_DIR: str = "/tmp/expense_tax_storage"
    GCS_BUCKET_NAME: str = "expense-receipts-dev"
    GCS_PROJECT_ID: str = ""

    # Temporal
    TEMPORAL_HOST: str = "localhost:7233"
    TEMPORAL_NAMESPACE: str = "expense-management"

    # Neo4j / Graphiti
    NEO4J_URI: str = "bolt://localhost:7687"
    NEO4J_USER: str = "neo4j"
    NEO4J_PASSWORD: str = "password"

    # LLM & OCR
    LLM_PROVIDER: str = "openai"  # "openai" | "openrouter" | "paddleocr"
    OPENAI_API_KEY: str = ""
    OPENROUTER_API_KEY: str = ""

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", case_sensitive=True, extra="ignore"
    )


settings = Settings()
