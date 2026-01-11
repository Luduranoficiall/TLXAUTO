import base64
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

import jwt

JWT_SECRET = os.getenv("JWT_SECRET", "CHANGE_ME_SUPER_SECRET")
JWT_ISSUER = "tlx-ads"
JWT_ALGO = "HS256"
JWT_EXPIRES_MIN = int(os.getenv("JWT_EXPIRES_MIN", "120"))

PWD_SALT = os.getenv("PWD_SALT", "CHANGE_ME_SALT").encode("utf-8")
PBKDF2_ITERATIONS = int(os.getenv("PWD_ITERATIONS", "200000"))


def _pepper(password: str) -> bytes:
    # Mantemos o nome PWD_SALT por compatibilidade com seu setup, mas aqui ele funciona como PEPPER.
    # O salt de verdade (por usuário) é gerado aleatoriamente e armazenado junto do hash.
    return password.encode("utf-8") + b"\x00" + PWD_SALT


def _b64e(b: bytes) -> str:
    return base64.b64encode(b).decode("utf-8")


def _b64d(s: str) -> bytes:
    return base64.b64decode(s.encode("utf-8"))


def _pbkdf2_hash(password: str) -> str:
    # LEGADO (compat): PBKDF2-HMAC-SHA256 com salt global.
    # Mantido apenas para login de usuários existentes antes da melhoria.
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), PWD_SALT, 200_000)
    return _b64e(dk)


def verify_password(password: str, password_hash: str) -> bool:
    # Formato novo:
    #   pbkdf2_sha256$<iterations>$<salt_b64>$<hash_b64>
    if password_hash.startswith("pbkdf2_sha256$"):
        try:
            _, it_s, salt_b64, hash_b64 = password_hash.split("$", 3)
            it = int(it_s)
            salt = _b64d(salt_b64)
            expected = _b64d(hash_b64)
        except Exception:
            return False

        computed = hashlib.pbkdf2_hmac("sha256", _pepper(password), salt, it)
        return hmac.compare_digest(computed, expected)

    # Formato legado
    computed_legacy = _pbkdf2_hash(password)
    return hmac.compare_digest(computed_legacy, password_hash)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", _pepper(password), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${_b64e(salt)}${_b64e(dk)}"


def create_token(user_id: int, email: str) -> str:
    now = datetime.now(timezone.utc)
    payload: Dict[str, Any] = {
        "iss": JWT_ISSUER,
        "sub": str(user_id),
        # Multi-tenant (padrão: 0 quando ainda não definido)
        "tid": 0,
        "role": "admin",
        "email": email,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=JWT_EXPIRES_MIN)).timestamp()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


def create_token_tenant(user_id: int, tenant_id: int, email: str, role: str) -> str:
    now = datetime.now(timezone.utc)
    payload: Dict[str, Any] = {
        "iss": JWT_ISSUER,
        "sub": str(user_id),
        "tid": int(tenant_id),
        "role": role,
        "email": email,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=JWT_EXPIRES_MIN)).timestamp()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


def decode_token(token: str) -> Optional[Dict[str, Any]]:
    try:
        payload = jwt.decode(
            token,
            JWT_SECRET,
            algorithms=[JWT_ALGO],
            issuer=JWT_ISSUER,
            options={"require": ["exp", "iat", "iss", "sub"]},
        )
        return payload
    except Exception:
        return None
