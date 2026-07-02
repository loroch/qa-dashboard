"""Mexico QA Team dashboard routes."""
import json
import anthropic
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List

from app.services.mexico_qa_service import get_mexico_qa_service
from app.config import get_settings

router = APIRouter(prefix="/api/mexico-qa", tags=["mexico-qa"])


@router.get("/team")
async def get_team(refresh: bool = Query(False)):
    svc = get_mexico_qa_service()
    try:
        return {"members": await svc.get_team(force_refresh=refresh)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/pinned-epics")
async def get_pinned_epics(refresh: bool = Query(False)):
    svc = get_mexico_qa_service()
    try:
        return {"epics": await svc.get_pinned_epics(force_refresh=refresh)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/search-epics")
async def search_epics(q: str = Query(..., min_length=1)):
    svc = get_mexico_qa_service()
    try:
        return {"epics": await svc.search_epics(q)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/epic-work")
async def get_epic_work(
    epic_key:   str          = Query(...),
    member_ids: str          = Query(..., description="Comma-separated account IDs"),
    refresh:    bool         = Query(False),
):
    svc = get_mexico_qa_service()
    try:
        ids = [i.strip() for i in member_ids.split(",") if i.strip()]
        return await svc.get_epic_work(epic_key.upper(), ids, force_refresh=refresh)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/bugs")
async def get_bugs(
    days:       int          = Query(14),
    member_ids: str          = Query(..., description="Comma-separated account IDs"),
    refresh:    bool         = Query(False),
):
    svc = get_mexico_qa_service()
    try:
        ids = [i.strip() for i in member_ids.split(",") if i.strip()]
        bugs = await svc.get_bugs_by_date(days, ids, force_refresh=refresh)
        return {"bugs": bugs, "total": len(bugs)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/assigned")
async def get_assigned(
    days:       int  = Query(14),
    member_ids: str  = Query(..., description="Comma-separated account IDs"),
    refresh:    bool = Query(False),
):
    svc = get_mexico_qa_service()
    try:
        ids = [i.strip() for i in member_ids.split(",") if i.strip()]
        grouped = await svc.get_assigned_by_date(days, ids, force_refresh=refresh)
        return {"grouped": grouped}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class TranslateRequest(BaseModel):
    texts: List[str]


@router.post("/translate")
async def translate_texts(body: TranslateRequest):
    """Batch-translate Spanish texts to English using Claude."""
    settings = get_settings()
    if not settings.anthropic_api_key:
        raise HTTPException(status_code=503, detail="Translation unavailable: no AI key configured")
    if not body.texts:
        return {"translations": {}}

    unique = list(dict.fromkeys(t for t in body.texts if t and t.strip()))
    if not unique:
        return {"translations": {}}

    numbered = "\n".join(f"{i+1}. {t}" for i, t in enumerate(unique))
    prompt = (
        "You are a translator. Translate each numbered Spanish text below to English. "
        "Return ONLY a JSON object where each key is the original Spanish text and the value is the English translation. "
        "Do NOT add any explanation, markdown, or extra text — just the raw JSON object.\n\n"
        f"{numbered}"
    )

    try:
        client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
        msg = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = msg.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        translations: dict = json.loads(raw)
    except json.JSONDecodeError:
        translations = {}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Translation failed: {e}")

    return {"translations": translations}
