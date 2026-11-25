"""Serve the built planner and its FastAPI routes from the same origin."""
from pathlib import Path

from starlette.staticfiles import StaticFiles

from .main import app

frontend = Path(__file__).resolve().parents[2] / "frontend" / "dist"
app.mount("/", StaticFiles(directory=frontend, html=True), name="planner")
