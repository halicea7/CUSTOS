"""repos.tracked_ref: scan a specific branch or tag instead of the default branch

Revision ID: 0013
Revises: 0012
Create Date: 2026-11-03 00:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("repos", sa.Column("tracked_ref", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("repos", "tracked_ref")
