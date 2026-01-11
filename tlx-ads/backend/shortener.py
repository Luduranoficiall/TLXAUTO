import secrets
import string

ALPH = string.ascii_letters + string.digits


def generate_slug(length: int = 7) -> str:
    return "".join(secrets.choice(ALPH) for _ in range(length))
