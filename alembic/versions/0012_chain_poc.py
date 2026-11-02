"""attack_chains: admin-generated, admin-only exploitation PoC per chain

Revision ID: 0012
Revises: 0011
Create Date: 2026-11-02 00:00:00.000000
"""

import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("attack_chains", sa.Column("poc", sa.JSON(), nullable=True))
    op.add_column("attack_chains", sa.Column("poc_model", sa.Text(), nullable=True))
    op.add_column("attack_chains", sa.Column("poc_generated_by", sa.Text(), nullable=True))
    op.add_column("attack_chains", sa.Column("poc_generated_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("attack_chains", "poc_generated_at")
    op.drop_column("attack_chains", "poc_generated_by")
    op.drop_column("attack_chains", "poc_model")
    op.drop_column("attack_chains", "poc")
