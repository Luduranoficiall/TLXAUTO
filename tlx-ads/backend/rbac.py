from fastapi import HTTPException

ROLE_ADMIN = "admin"
ROLE_EDITOR = "editor"
ROLE_VIEWER = "viewer"

ROLE_ORDER = {
    ROLE_VIEWER: 1,
    ROLE_EDITOR: 2,
    ROLE_ADMIN: 3,
}


def require_role(current_role: str, minimum: str) -> None:
    if ROLE_ORDER.get(current_role, 0) < ROLE_ORDER.get(minimum, 0):
        raise HTTPException(status_code=403, detail="Insufficient permissions")
