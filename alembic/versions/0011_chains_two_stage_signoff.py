"""attack_chains table; awaiting_approval submission status (two-stage sign-off)

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-13 00:00:00.000000
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None

_OLD = "status IN ('pending', 'analyzing', 'needs_review', 'signed_off', 'error')"
_NEW = "status IN ('pending', 'analyzing', 'needs_review', 'awaiting_approval', 'signed_off', 'error')"


def upgrade() -> None:
    op.drop_constraint("ck_submissions_status", "submissions", type_="check")
    op.create_check_constraint("ck_submissions_status", "submissions", _NEW)
    op.create_table(
        "attack_chains",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("submission_id", UUID(as_uuid=True), sa.ForeignKey("submissions.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("severity", sa.Text(), nullable=False),
        sa.Column("confidence", sa.Text(), nullable=False),
        sa.Column("narrative", sa.Text(), nullable=True),
        sa.Column("steps", sa.JSON(), nullable=False),
        sa.Column("break_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_attack_chains_submission_id", "attack_chains", ["submission_id"])


def downgrade() -> None:
    op.drop_index("ix_attack_chains_submission_id", table_name="attack_chains")
    op.drop_table("attack_chains")
    # Runs waiting for approval go back to needing review.
    op.execute("UPDATE submissions SET status = 'needs_review' WHERE status = 'awaiting_approval'")
    op.drop_constraint("ck_submissions_status", "submissions", type_="check")
    op.create_check_constraint("ck_submissions_status", "submissions", _OLD)
