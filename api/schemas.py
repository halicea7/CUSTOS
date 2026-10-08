import json
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from enums import Disposition, Role


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserResponse(BaseModel):
    username: str
    role: str

    model_config = {"from_attributes": True}


class SubmissionResponse(BaseModel):
    id: UUID
    repo_full_name: str
    repo_url: str
    commit_sha: str
    branch: str | None = None
    submitter: str | None = None
    github_actor: str | None = None
    event_type: str | None = None
    pr_number: int | None = None
    status: str
    error_message: str | None = None
    created_at: datetime
    updated_at: datetime
    finding_counts: dict | None = None

    @field_validator("finding_counts", mode="before")
    @classmethod
    def parse_finding_counts(cls, v: Any) -> dict | None:
        if isinstance(v, str):
            try:
                return json.loads(v)
            except Exception:
                return None
        return v

    model_config = {"from_attributes": True}


class SubmissionListResponse(BaseModel):
    submissions: list[SubmissionResponse]
    total: int


class FindingResponse(BaseModel):
    id: UUID
    submission_id: UUID
    source: str
    severity: str
    cwe: str | None = None
    title: str
    description: str | None = None
    file_path: str | None = None
    line_start: int | None = None
    line_end: int | None = None
    code_snippet: str | None = None
    remediation: str | None = None
    llm_reasoning: str | None = None
    disposition: str | None = None
    disposed_by: str | None = None
    disposed_at: datetime | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class LlmRunResponse(BaseModel):
    id: UUID
    triggered_by: str
    model: str
    status: str
    duration_seconds: float | None = None
    findings_count: int | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    error: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None

    model_config = {"from_attributes": True}


class DispositionRequest(BaseModel):
    disposition: Disposition
    note: str | None = Field(None, max_length=5000)


class SignoffRequest(BaseModel):
    note: str | None = Field(None, max_length=5000)


class AuditLogResponse(BaseModel):
    id: UUID
    submission_id: UUID
    finding_id: UUID | None = None
    analyst: str
    action: str
    note: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class WebhookResponse(BaseModel):
    status: str
    submission_id: str | None = None


# Settings schemas

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=256)


class CreateUserRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=8, max_length=256)
    role: Role = Role.ANALYST


class UserListResponse(BaseModel):
    id: UUID
    username: str
    role: str
    created_at: datetime

    model_config = {"from_attributes": True}


class UpdateUserRoleRequest(BaseModel):
    role: Role


class AppConfigResponse(BaseModel):
    # Provider: "ollama" (local) or "responses" (OpenAI Responses API format)
    llm_provider: str
    responses_base_url: str
    responses_model: str
    # The key itself is write-only.
    responses_api_key_set: bool
    responses_api_key_last4: str | None = None
    # Ollama
    ollama_base_url: str
    ollama_model: str
    ollama_think: bool
    ollama_num_ctx: int  # 0 = let Ollama/Modelfile decide
    # LLM context
    llm_max_content_chars: int
    # Scanning
    max_file_size_kb: int
    max_files_per_repo: int
    # Session
    access_token_expire_minutes: int
    # Worker (requires worker restart to take effect)
    worker_max_jobs: int
    worker_job_timeout: int


class AppConfigUpdateRequest(BaseModel):
    llm_provider: Literal["ollama", "responses"] | None = None
    responses_base_url: str | None = Field(None, pattern=r"^https?://[^\s]+$", max_length=500)
    responses_model: str | None = Field(None, max_length=200)
    # Write-only. An empty string removes the stored key.
    responses_api_key: str | None = Field(None, max_length=1000)
    ollama_base_url: str | None = Field(None, pattern=r"^https?://[^\s]+$", max_length=500)
    ollama_model: str | None = Field(None, min_length=1, max_length=200)
    ollama_think: bool | None = None
    ollama_num_ctx: int | None = Field(None, ge=0, le=1_048_576)
    llm_max_content_chars: int | None = Field(None, ge=1_000, le=2_000_000)
    max_file_size_kb: int | None = Field(None, ge=1, le=10_240)
    max_files_per_repo: int | None = Field(None, ge=1, le=10_000)
    access_token_expire_minutes: int | None = Field(None, ge=5, le=10_080)
    worker_max_jobs: int | None = Field(None, ge=1, le=64)
    worker_job_timeout: int | None = Field(None, ge=60, le=86_400)


class TestResponsesRequest(BaseModel):
    base_url: str = Field(..., pattern=r"^https?://[^\s]+$", max_length=500)
    api_key: str | None = Field(None, max_length=1000)


# ── Repo schemas ───────────────────────────────────────────────────────────────

class GroupSummary(BaseModel):
    id: UUID
    name: str

    model_config = {"from_attributes": True}


class RepoCreate(BaseModel):
    repo_full_name: str
    github_token: str
    webhook_secret: str
    group_ids: list[UUID] = []


class RepoUpdate(BaseModel):
    github_token: str | None = None
    webhook_secret: str | None = None
    enabled: bool | None = None


class RepoResponse(BaseModel):
    id: UUID
    repo_full_name: str
    added_by: str
    added_at: datetime
    last_push_at: datetime | None = None
    enabled: bool
    token_preview: str
    groups: list[GroupSummary] = []

    model_config = {"from_attributes": True}


class ValidateTokenRequest(BaseModel):
    repo_full_name: str
    github_token: str


# ── Group schemas ──────────────────────────────────────────────────────────────

class GroupCreate(BaseModel):
    name: str
    description: str | None = None


class GroupUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


class GroupMemberAdd(BaseModel):
    username: str


class GroupMemberResponse(BaseModel):
    username: str
    added_by: str
    joined_at: datetime


class GroupResponse(BaseModel):
    id: UUID
    name: str
    description: str | None = None
    created_by: str
    created_at: datetime
    member_count: int = 0

    model_config = {"from_attributes": True}
