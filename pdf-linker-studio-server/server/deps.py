"""
Shared FastAPI dependencies for project-scoped routing.

Every router that touches project data uses `get_current_project` to extract
the project_id from the `X-Project-Id` request header (or `?project_id=` query
param as a fallback). The ID is validated against the projects table.

Endpoints that don't belong to a project (e.g. listing projects, health check)
don't use this dependency.
"""
from fastapi import Header, HTTPException, Query
from typing import Optional

from . import database as db


# Sentinel used by legacy code paths that haven't been migrated to multi-project.
# (The frontend always sends a real project_id after the dashboard loads.)
DEFAULT_PROJECT_ID = "default"


def get_current_project(
    x_project_id: Optional[str] = Header(None, alias="X-Project-Id"),
    project_id_query: Optional[str] = Query(None, alias="project_id"),
) -> str:
    """Extract + validate the project ID for this request.

    Order of precedence:
      1. X-Project-Id header
      2. ?project_id= query parameter
      3. 'default' (backwards compatibility)

    Returns the validated project_id. Raises 404 if the project doesn't exist.
    """
    project_id = x_project_id or project_id_query or DEFAULT_PROJECT_ID
    project = db.query_one("SELECT id FROM projects WHERE id = ?", (project_id,))
    if not project:
        raise HTTPException(404, f"Project '{project_id}' does not exist")
    return project_id


def get_optional_project(
    x_project_id: Optional[str] = Header(None, alias="X-Project-Id"),
    project_id_query: Optional[str] = Query(None, alias="project_id"),
) -> str:
    """Like get_current_project but doesn't 404 if the project is missing —
    used for endpoints that should still respond (e.g. health check) even when
    no project has been selected yet."""
    return x_project_id or project_id_query or DEFAULT_PROJECT_ID
