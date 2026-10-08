"""repos.last_checked_at: when Custos last looked for new commits

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-08 00:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("repos", sa.Column("last_checked_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("repos", "last_checked_at")
