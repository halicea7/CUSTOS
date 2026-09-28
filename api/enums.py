"""Canonical string values for status-like columns.

Stored as TEXT with CHECK constraints (see migration 0006) so values stay
readable in SQL while the database rejects typos.
"""

from enum import StrEnum


class SubmissionStatus(StrEnum):
    PENDING = "pending"
    ANALYZING = "analyzing"
    NEEDS_REVIEW = "needs_review"
    SIGNED_OFF = "signed_off"
    ERROR = "error"


class Severity(StrEnum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    INFO = "info"


SEVERITY_ORDER = {s.value: i for i, s in enumerate(Severity)}
BLOCKING_SEVERITIES = (Severity.CRITICAL.value, Severity.HIGH.value)


class Disposition(StrEnum):
    CONFIRMED = "confirmed"
    FALSE_POSITIVE = "false_positive"
    ESCALATED = "escalated"


class Role(StrEnum):
    ADMIN = "admin"
    ANALYST = "analyst"


class RunStatus(StrEnum):
    RUNNING = "running"
    COMPLETE = "complete"
    FAILED = "failed"


def check_in(column: str, enum: type[StrEnum]) -> str:
    """SQL CHECK expression restricting *column* to the values of *enum*."""
    values = ", ".join(f"'{e.value}'" for e in enum)
    return f"{column} IN ({values})"
