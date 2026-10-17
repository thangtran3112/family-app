from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ai_trading.api.auth import AuthedUser, get_current_user

router = APIRouter(prefix="/api/desk", tags=["identity"])


class MeOut(BaseModel):
    email: str


@router.get("/me", response_model=MeOut)
def me(user: AuthedUser = Depends(get_current_user)) -> MeOut:
    return MeOut(email=user.email)
