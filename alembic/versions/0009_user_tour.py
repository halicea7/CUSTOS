"""users.tour_completed_at: when the user finished or skipped the welcome tour

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-13 00:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("tour_completed_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "tour_completed_at")
