"""
Auth routes — simple username/password login for the QA Dashboard webclient.
Credentials are stored in .env; no DB or JWT needed for this internal tool.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.config import get_settings

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str
    password: str


@router.post("/login")
async def login(body: LoginRequest):
    settings = get_settings()
    username = body.username.strip().lower()

    users = {
        "admin": {"password": settings.auth_admin_password, "role": "admin",  "display": "Admin"},
        "qa":    {"password": settings.auth_qa_password,    "role": "qa",     "display": "QA"},
    }

    user = users.get(username)
    if not user or user["password"] != body.password:
        raise HTTPException(status_code=401, detail="Invalid username or password")

    return {
        "ok":       True,
        "username": username,
        "display":  user["display"],
        "role":     user["role"],
    }
