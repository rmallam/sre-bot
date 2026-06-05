"""Environment-driven configuration for the Python SRE agent platform."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class PlatformSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env.local",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Semantic router
    router_encoder: Literal["openai", "google"] = Field(
        default="openai",
        alias="SRE_ROUTER_ENCODER",
    )
    router_score_threshold: float = Field(default=0.70, alias="SRE_ROUTER_SCORE_THRESHOLD")
    openai_api_key: SecretStr | None = Field(default=None, alias="OPENAI_API_KEY")
    openrouter_api_key: SecretStr | None = Field(default=None, alias="OPENROUTER_API_KEY")
    gemini_api_key: SecretStr | None = Field(default=None, alias="GEMINI_API_KEY")

    # Embeddings (RAG)
    embedding_provider: Literal["openai", "google"] = Field(
        default="openai",
        alias="SRE_EMBEDDING_PROVIDER",
    )
    embedding_model_openai: str = Field(
        default="text-embedding-3-small",
        alias="SRE_EMBEDDING_MODEL_OPENAI",
    )
    embedding_model_google: str = Field(
        default="models/embedding-001",
        alias="SRE_EMBEDDING_MODEL_GOOGLE",
    )
    embedding_dimensions: int = Field(default=1536, alias="SRE_EMBEDDING_DIMENSIONS")

    # EDB Postgres + pgvector (CloudNativePG)
    rag_database_url: str = Field(
        default="postgresql://sre:sre@localhost:5432/sre_rag",
        alias="SRE_RAG_DATABASE_URL",
    )
    rag_table: str = Field(default="sre_runbooks", alias="SRE_RAG_TABLE")
    rag_pool_min: int = Field(default=1, alias="SRE_RAG_POOL_MIN")
    rag_pool_max: int = Field(default=10, alias="SRE_RAG_POOL_MAX")

    # Loop safety
    max_verification_attempts: int = Field(default=5, alias="SRE_MAX_VERIFICATION_ATTEMPTS")


@lru_cache
def get_settings() -> PlatformSettings:
    return PlatformSettings()
