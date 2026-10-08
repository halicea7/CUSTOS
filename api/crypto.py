"""Symmetric encryption for secrets stored in the database.

Keys come from ENCRYPTION_KEY (comma-separated Fernet keys; the first encrypts,
all decrypt). A key derived from SECRET_KEY is always appended as a decrypt-only
fallback so rows written before ENCRYPTION_KEY existed stay readable. Run
``python manage.py rotate-keys`` to re-encrypt those rows under the new key.
"""

import base64
import hashlib
from functools import lru_cache

from cryptography.fernet import Fernet, MultiFernet


def _legacy_key() -> Fernet:
    from config import settings
    key = hashlib.sha256(settings.SECRET_KEY.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


@lru_cache(maxsize=1)
def _fernet() -> MultiFernet:
    from config import settings
    keys = [Fernet(k.strip().encode()) for k in settings.ENCRYPTION_KEY.split(",") if k.strip()]
    keys.append(_legacy_key())
    return MultiFernet(keys)


def encrypt(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: str) -> str:
    return _fernet().decrypt(ciphertext.encode()).decode()


def rotate(ciphertext: str) -> str:
    """Re-encrypt *ciphertext* under the primary key."""
    return _fernet().rotate(ciphertext.encode()).decode()
