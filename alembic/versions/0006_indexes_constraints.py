"""indexes, check constraints, check_run_id, token_last4

Revision ID: 0006
Revises: 0005
Create Date: 2026-09-28 00:00:00.000000
"""

import os
import sys

import sqlalchemy as sa
from alembic import op

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "api"))

from enums import Disposition, Role, RunStatus, Severity, SubmissionStatus, check_in  # noqa: E402

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

_CHECKS = [
    ("ck_users_role", "users", check_in("role", Role)),
    ("ck_submissions_status", "submissions", check_in("status", SubmissionStatus)),
    ("ck_findings_severity", "findings", check_in("severity", Severity)),
    (
        "ck_findings_disposition",
        "findings",
        f"disposition IS NULL OR {check_in('disposition', Disposition)}",
    ),
    ("ck_llm_runs_status", "llm_runs", check_in("status", RunStatus)),
    ("ck_self_scans_status", "self_scans", check_in("status", RunStatus)),
    ("ck_self_scan_findings_severity", "self_scan_findings", check_in("severity", Severity)),
]

# Created with a server default but left nullable in 0001; nothing writes NULL.
_NOT_NULL = [
    ("users", "created_at"),
    ("submissions", "created_at"),
    ("submissions", "updated_at"),
    ("findings", "created_at"),
    ("audit_log", "created_at"),
]

_INDEXES = [
    ("ix_submissions_repo_full_name", "submissions", ["repo_full_name"]),
    ("ix_submissions_status_created_at", "submissions", ["status", "created_at"]),
    ("ix_findings_submission_severity_disposition", "findings", ["submission_id", "severity", "disposition"]),
    ("ix_audit_log_finding_id", "audit_log", ["finding_id"]),
    ("ix_audit_log_submission_id", "audit_log", ["submission_id"]),
]


def upgrade() -> None:
    op.add_column("submissions", sa.Column("check_run_id", sa.BigInteger(), nullable=True))
    op.add_column("repos", sa.Column("token_last4", sa.Text(), nullable=True))

    # Normalise any stray values so the constraints can be added.
    sev = ", ".join(f"'{s.value}'" for s in Severity)
    op.execute(f"UPDATE findings SET severity = 'info' WHERE severity NOT IN ({sev})")
    op.execute(f"UPDATE self_scan_findings SET severity = 'info' WHERE severity NOT IN ({sev})")

    for table, col in _NOT_NULL:
        op.execute(f"UPDATE {table} SET {col} = now() WHERE {col} IS NULL")
        op.alter_column(table, col, nullable=False)
    for name, table, cols in _INDEXES:
        op.create_index(name, table, cols)
    # Redundant: the UNIQUE constraint on repo_full_name already has an index.
    op.drop_index("ix_repos_repo_full_name", table_name="repos")
    for name, table, expr in _CHECKS:
        op.create_check_constraint(name, table, expr)


def downgrade() -> None:
    for name, table, _ in reversed(_CHECKS):
        op.drop_constraint(name, table, type_="check")
    op.create_index("ix_repos_repo_full_name", "repos", ["repo_full_name"])
    for name, table, _ in reversed(_INDEXES):
        op.drop_index(name, table_name=table)
    for table, col in _NOT_NULL:
        op.alter_column(table, col, nullable=True)
    op.drop_column("repos", "token_last4")
    op.drop_column("submissions", "check_run_id")
