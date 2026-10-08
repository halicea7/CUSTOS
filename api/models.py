import uuid
from datetime import UTC, datetime

import sqlalchemy as sa
from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base
from enums import Disposition, Role, RunStatus, Severity, SubmissionStatus, check_in


def _now() -> datetime:
    return datetime.now(UTC)


def _uuid_pk():
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


def _created_at():
    return mapped_column(DateTime(timezone=True), nullable=False, default=_now, server_default=func.now())


class User(Base):
    __tablename__ = "users"
    __table_args__ = (CheckConstraint(check_in("role", Role), name="ck_users_role"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    username: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False, default=Role.ANALYST.value)
    created_at: Mapped[datetime] = _created_at()


class Submission(Base):
    __tablename__ = "submissions"
    __table_args__ = (
        CheckConstraint(check_in("status", SubmissionStatus), name="ck_submissions_status"),
        Index("ix_submissions_repo_full_name", "repo_full_name"),
        Index("ix_submissions_status_created_at", "status", "created_at"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    repo_full_name: Mapped[str] = mapped_column(Text, nullable=False)
    repo_url: Mapped[str] = mapped_column(Text, nullable=False)
    commit_sha: Mapped[str] = mapped_column(Text, nullable=False)
    branch: Mapped[str | None] = mapped_column(Text)
    submitter: Mapped[str | None] = mapped_column(Text)
    event_type: Mapped[str | None] = mapped_column(Text)
    pr_number: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(Text, nullable=False, default=SubmissionStatus.PENDING.value)
    error_message: Mapped[str | None] = mapped_column(Text)
    # GitHub check run created for this commit, updated in place as analysis progresses.
    check_run_id: Mapped[int | None] = mapped_column(sa.BigInteger)
    created_at: Mapped[datetime] = _created_at()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_now, onupdate=_now, server_default=func.now()
    )

    findings: Mapped[list["Finding"]] = relationship(
        "Finding", back_populates="submission", cascade="all, delete-orphan"
    )


class Finding(Base):
    __tablename__ = "findings"
    __table_args__ = (
        CheckConstraint(check_in("severity", Severity), name="ck_findings_severity"),
        CheckConstraint(
            f"disposition IS NULL OR {check_in('disposition', Disposition)}",
            name="ck_findings_disposition",
        ),
        Index("ix_findings_submission_severity_disposition", "submission_id", "severity", "disposition"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    submission_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("submissions.id", ondelete="CASCADE"), nullable=False
    )
    source: Mapped[str] = mapped_column(Text, nullable=False)
    severity: Mapped[str] = mapped_column(Text, nullable=False)
    cwe: Mapped[str | None] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    file_path: Mapped[str | None] = mapped_column(Text)
    line_start: Mapped[int | None] = mapped_column(Integer)
    line_end: Mapped[int | None] = mapped_column(Integer)
    code_snippet: Mapped[str | None] = mapped_column(Text)
    remediation: Mapped[str | None] = mapped_column(Text)
    llm_reasoning: Mapped[str | None] = mapped_column(Text)
    disposition: Mapped[str | None] = mapped_column(Text)
    disposed_by: Mapped[str | None] = mapped_column(Text)
    disposed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _created_at()

    submission: Mapped["Submission"] = relationship("Submission", back_populates="findings")


class AppConfig(Base):
    __tablename__ = "app_config"

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, server_default=func.now()
    )
    updated_by: Mapped[str] = mapped_column(Text, nullable=False)


class LlmRun(Base):
    __tablename__ = "llm_runs"
    __table_args__ = (CheckConstraint(check_in("status", RunStatus), name="ck_llm_runs_status"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    submission_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("submissions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    triggered_by: Mapped[str] = mapped_column(Text, nullable=False)  # "initial" | "rerun"
    model: Mapped[str] = mapped_column(Text, nullable=False)
    duration_seconds: Mapped[float | None] = mapped_column(sa.Float)
    findings_count: Mapped[int | None] = mapped_column(Integer)
    prompt_tokens: Mapped[int | None] = mapped_column(Integer)
    completion_tokens: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(Text, nullable=False, default=RunStatus.RUNNING.value)
    error: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime] = _created_at()
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SelfScan(Base):
    __tablename__ = "self_scans"
    __table_args__ = (CheckConstraint(check_in("status", RunStatus), name="ck_self_scans_status"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    status: Mapped[str] = mapped_column(Text, nullable=False, default=RunStatus.RUNNING.value)
    overall_health: Mapped[str | None] = mapped_column(Text)  # healthy|warning|urgent
    triggered_by: Mapped[str] = mapped_column(Text, nullable=False)  # manual|scheduled
    triggered_by_user: Mapped[str | None] = mapped_column(Text)
    finding_counts: Mapped[str | None] = mapped_column(Text)  # JSON {"critical":0, ...}
    config_issue_count: Mapped[int | None] = mapped_column(Integer)
    started_at: Mapped[datetime] = _created_at()
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(Text)


class SelfScanFinding(Base):
    __tablename__ = "self_scan_findings"
    __table_args__ = (CheckConstraint(check_in("severity", Severity), name="ck_self_scan_findings_severity"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    scan_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("self_scans.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source: Mapped[str] = mapped_column(Text, nullable=False)   # semgrep|gitleaks|pip_audit|npm_audit|config|llm
    category: Mapped[str] = mapped_column(Text, nullable=False)  # sast|secrets|dependencies|config|llm
    severity: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    file_path: Mapped[str | None] = mapped_column(Text)
    line_start: Mapped[int | None] = mapped_column(Integer)
    line_end: Mapped[int | None] = mapped_column(Integer)
    cwe: Mapped[str | None] = mapped_column(Text)
    remediation: Mapped[str | None] = mapped_column(Text)
    llm_reasoning: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created_at()


class Repo(Base):
    __tablename__ = "repos"

    id: Mapped[uuid.UUID] = _uuid_pk()
    repo_full_name: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    github_token_enc: Mapped[str] = mapped_column(Text, nullable=False)
    webhook_secret_enc: Mapped[str] = mapped_column(Text, nullable=False)
    # Last 4 characters of the token, so listing repos needn't decrypt anything.
    token_last4: Mapped[str | None] = mapped_column(Text)
    added_by: Mapped[str] = mapped_column(Text, nullable=False)
    added_at: Mapped[datetime] = _created_at()
    last_push_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Last "Check for updates" (manual or scheduled): polling instead of a webhook.
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    enabled: Mapped[bool] = mapped_column(sa.Boolean, nullable=False, default=True)


class Group(Base):
    __tablename__ = "groups"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = _created_at()


class GroupMember(Base):
    __tablename__ = "group_members"

    group_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("groups.id", ondelete="CASCADE"), primary_key=True
    )
    username: Mapped[str] = mapped_column(Text, primary_key=True, index=True)
    added_by: Mapped[str] = mapped_column(Text, nullable=False)
    joined_at: Mapped[datetime] = _created_at()


class RepoGroup(Base):
    __tablename__ = "repo_groups"

    repo_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("repos.id", ondelete="CASCADE"), primary_key=True
    )
    group_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("groups.id", ondelete="CASCADE"), primary_key=True, index=True
    )


class AuditLog(Base):
    __tablename__ = "audit_log"
    __table_args__ = (
        Index("ix_audit_log_finding_id", "finding_id"),
        Index("ix_audit_log_submission_id", "submission_id"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    submission_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    finding_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    analyst: Mapped[str] = mapped_column(Text, nullable=False)
    action: Mapped[str] = mapped_column(Text, nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created_at()
