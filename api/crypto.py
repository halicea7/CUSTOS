import base64
import hashlib
from cryptography.fernet import Fernet, MultiFernet


def _derive(key: str) -> Fernet:
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(key.encode()).digest()))


def _fernet() -> MultiFernet:
    """Current key encrypts; current + previous keys can decrypt."""
    from config import settings
    primary = settings.ENCRYPTION_KEY or settings.SECRET_KEY
    previous = [k.strip() for k in settings.PREVIOUS_ENCRYPTION_KEYS.split(",") if k.strip()]
    return MultiFernet([_derive(primary), *(_derive(k) for k in previous)])


def encrypt(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: str) -> str:
    return _fernet().decrypt(ciphertext.encode()).decode()


def rotate(ciphertext: str) -> str:
    """Re-encrypt *ciphertext* under the current primary key."""
    return _fernet().rotate(ciphertext.encode()).decode()
