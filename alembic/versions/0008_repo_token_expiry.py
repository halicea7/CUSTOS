"""repos.token_expires_at: when the repo's GitHub token expires

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-13 00:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("repos", sa.Column("token_expires_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("repos", "token_expires_at")
