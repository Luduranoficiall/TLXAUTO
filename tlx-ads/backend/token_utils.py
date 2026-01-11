import secrets


def secure_token(length_bytes: int = 32) -> str:
    """Gera token URL-safe para convites/reset.

    ~43 chars quando length_bytes=32.
    """

    return secrets.token_urlsafe(length_bytes)
