"""
Pydantic models for the changelog / audit trail system.
"""
from typing import Any, Optional
from datetime import datetime
from pydantic import BaseModel


class ChangelogEntry(BaseModel):
    id: int
    change_type: str        # config | query | widget | design | backend | jira
    component: str          # Which part changed (e.g. "field_mapping", "rft_widget")
    description: str        # Human-readable description
    old_value: Optional[Any] = None
    new_value: Optional[Any] = None
    changed_by: str = "system"
    changed_at: str
    version: str            # Dashboard version at time of change
    metadata: Optional[dict] = None


class ChangelogEntryCreate(BaseModel):
    change_type: str
    component: str
    description: str
    old_value: Optional[Any] = None
    new_value: Optional[Any] = None
    changed_by: str = "system"
    version: str = "1.0.0"
    metadata: Optional[dict] = None


class ChangelogPage(BaseModel):
    entries: list[ChangelogEntry]
    total: int
    page: int
    page_size: int
    total_pages: int


class ChangelogFilter(BaseModel):
    change_type: Optional[str] = None
    component: Optional[str] = None
    changed_by: Optional[str] = None
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    version: Optional[str] = None
