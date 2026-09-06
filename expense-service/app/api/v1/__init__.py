from fastapi import APIRouter

from app.api.v1.auth import router as auth_router
from app.api.v1.expenses import router as expenses_router
from app.api.v1.projects import router as projects_router
from app.api.v1.categories import router as categories_router

api_v1_router = APIRouter()
api_v1_router.include_router(auth_router)
api_v1_router.include_router(expenses_router)
api_v1_router.include_router(projects_router)
api_v1_router.include_router(categories_router)
