import os
from pathlib import Path
from typing import List
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field
import yaml

# Resolve .env from project root (one level above /backend)
_ENV_FILE = Path(__file__).parent.parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(_ENV_FILE),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Jira
    jira_base_url: str = Field(..., description="Jira instance base URL")
    jira_user_email: str = Field(..., description="Jira user email for API auth")
    jira_api_token: str = Field(..., description="Jira API token")
    jira_max_results: int = Field(100, description="Max results per Jira page")
    jira_request_timeout: int = Field(30, description="HTTP timeout in seconds")

    # Config
    field_mapping_path: str = Field("./config/field_mapping.yaml")

    # Cache
    cache_ttl_seconds: int = Field(300, description="Cache TTL: 5 minutes")
    background_refresh_hours: int = Field(5, description="Full refresh every N hours")

    # Database
    database_url: str = Field("sqlite+aiosqlite:///./data/qa_dashboard.db")

    # Server
    api_host: str = Field("0.0.0.0")
    api_port: int = Field(8000)
    log_level: str = Field("INFO")
    environment: str = Field("development")

    # CORS
    cors_origins: str = Field("http://localhost:5173,http://localhost:3000")

    # Security
    secret_key: str = Field("change-me-in-production")

    # Export
    export_max_rows: int = Field(10000)

    # Zoho Desk
    zoho_client_id: str = Field("", description="Zoho OAuth client ID")
    zoho_client_secret: str = Field("", description="Zoho OAuth client secret")
    zoho_refresh_token: str = Field("", description="Zoho OAuth refresh token")
    zoho_desk_portal: str = Field("cityshob", description="Zoho Desk portal name")
    zoho_accounts_url: str = Field("https://accounts.zoho.com")
    zoho_desk_base_url: str = Field("https://desk.zoho.com")

    @property
    def cors_origins_list(self) -> List[str]:
        return [o.strip() for o in self.cors_origins.split(",")]

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


_settings: Settings | None = None
_field_mapping: dict | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings


def get_field_mapping() -> dict:
    global _field_mapping
    if _field_mapping is None:
        settings = get_settings()
        path = Path(settings.field_mapping_path)
        if not path.exists():
            # Try relative to project root
            path = Path(__file__).parent.parent.parent / settings.field_mapping_path
        with open(path, "r") as f:
            _field_mapping = yaml.safe_load(f)
    return _field_mapping


def reload_field_mapping() -> dict:
    """Force reload of field mapping config."""
    global _field_mapping
    _field_mapping = None
    return get_field_mapping()
