"""users.last_login_at / last_seen_at and the user_activity log

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-13 00:00:00.000000
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("users", sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True))
    op.create_table(
        "user_activity",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("username", sa.Text(), nullable=False),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_user_activity_username_created", "user_activity", ["username", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_user_activity_username_created", table_name="user_activity")
    op.drop_table("user_activity")
    op.drop_column("users", "last_seen_at")
    op.drop_column("users", "last_login_at")
