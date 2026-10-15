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
    tour_completed_at: datetime | None = None

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
    # Custos's own repo: signing off approves `./custos update` deploying it.
    is_self_update: bool = False

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


class BulkDispositionRequest(DispositionRequest):
    finding_ids: list[UUID] = Field(..., min_length=1, max_length=500)


class AgentTriageItem(BaseModel):
    """One row of an AI agent's verdict table (from REMEDIATIONS.md), as the analyst approved it."""
    finding_id: UUID
    disposition: Disposition
    verdict: Literal["valid", "not valid", "unsure"]
    action: str | None = Field(None, max_length=40)
    reason: str = Field(..., min_length=1, max_length=600)


class AgentTriageRequest(BaseModel):
    submission_id: UUID
    items: list[AgentTriageItem] = Field(..., min_length=1, max_length=500)


class SignoffRequest(BaseModel):
    note: str | None = Field(None, max_length=5000)


class ReturnSignoffRequest(BaseModel):
    # Why it goes back: the analyst sees this on the run page.
    note: str = Field(..., min_length=1, max_length=5000)


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
    last_login_at: datetime | None = None
    last_seen_at: datetime | None = None
    # Filled in by GET /settings/users.
    findings_triaged: int = 0
    signoffs: int = 0
    repos_added: int = 0

    model_config = {"from_attributes": True}


class UpdateUserRoleRequest(BaseModel):
    role: Role


class AppConfigResponse(BaseModel):
    # Registered repo that is Custos's own source ("" = self-update off).
    self_update_repo: str = ""
    # Text under the sign-in box ("" hides it).
    login_footer: str = ""
    # Responses API "thinking" (reasoning.effort; "" = off) and output cap (0 = server default).
    responses_reasoning_effort: str = ""
    responses_max_output_tokens: int = 0
    # http:// origin an admin explicitly allowed for the Responses API key.
    responses_http_allowed_origin: str | None = None
    # SentinelOne CNS layer. The token itself is write-only.
    s1_enabled: bool = False
    s1_console_url: str = ""
    s1_scope_type: str = "ACCOUNT"
    s1_scope_id: str = ""
    # Scanner policy: without one the CLI enables secret scanning only.
    s1_policy_id: str = ""
    s1_scanners: list[str] = []
    s1_verify_secrets: bool = False
    s1_publish: bool = False
    s1_token_set: bool = False
    s1_token_last4: str | None = None
    s1_token_origin: str | None = None
    # Provider: "ollama" (local) or "responses" (OpenAI Responses API format)
    llm_provider: str
    responses_base_url: str
    responses_model: str
    # The key itself is write-only.
    # Whether a key will be sent to responses_base_url, and which origin a
    # saved key is bound to (it is never sent anywhere else).
    responses_api_key_set: bool
    responses_api_key_last4: str | None = None
    responses_api_key_origin: str | None = None
    # Amazon Bedrock (Responses API on bedrock-mantle or bedrock-runtime). Key is write-only.
    bedrock_region: str = ""
    bedrock_endpoint: str = "mantle"
    bedrock_model: str = ""
    bedrock_project_id: str = ""
    bedrock_reasoning_effort: str = ""
    bedrock_max_output_tokens: int = 0
    bedrock_api_key_set: bool = False
    bedrock_api_key_last4: str | None = None
    # Ollama
    ollama_base_url: str
    ollama_model: str
    ollama_think: bool
    ollama_num_ctx: int  # 0 = let Ollama/Modelfile decide
    # LLM context
    llm_max_content_chars: int
    # Optional scanners that run next to Semgrep, Gitleaks, pip-audit and npm audit.
    extra_scanners: list[str] = []
    # Attack chains: an LLM pass over each run's findings; critical/high chains can gate sign-off.
    chains_enabled: bool = True
    chain_gate: bool = True
    # A second LLM pass re-checks critical/high AI findings with the code around them.
    verify_llm_findings: bool = True
    # Scanning
    max_file_size_kb: int
    max_files_per_repo: int
    # Session
    access_token_expire_minutes: int
    # Worker (requires worker restart to take effect)
    worker_max_jobs: int
    worker_job_timeout: int
    repo_check_interval_hours: int


class AppConfigUpdateRequest(BaseModel):
    # "" turns self-update off.
    self_update_repo: str | None = Field(None, max_length=200)
    # Plain text, one line; "" hides it.
    login_footer: str | None = Field(None, max_length=120, pattern=r"^[^\n\r<>]*$")
    # "" = model default (send nothing); "none" = explicitly off.
    responses_reasoning_effort: Literal["", "none", "low", "medium", "high"] | None = None
    responses_max_output_tokens: int | None = Field(None, ge=0, le=1_000_000)
    # Allow plain HTTP for this exact http:// origin (must match the base
    # URL's origin); "" revokes the exception.
    responses_http_allowed_origin: str | None = Field(None, max_length=300)
    s1_enabled: bool | None = None
    s1_console_url: str | None = Field(None, pattern=r"^https://[^\s/]+/?$", max_length=300)
    s1_scope_type: Literal["ACCOUNT", "SITE"] | None = None
    s1_scope_id: str | None = Field(None, pattern=r"^\d{1,30}$")
    # "" clears it.
    s1_policy_id: str | None = Field(None, pattern=r"^(?:[A-Za-z0-9_][A-Za-z0-9_-]{0,99})?$")
    s1_scanners: list[Literal["secret", "iac", "vuln"]] | None = Field(None, min_length=1)
    s1_verify_secrets: bool | None = None
    s1_publish: bool | None = None
    # Write-only. An empty string removes the stored token.
    s1_api_token: str | None = Field(None, max_length=4000)
    llm_provider: Literal["ollama", "responses", "bedrock"] | None = None
    bedrock_region: str | None = Field(None, pattern=r"^(?:[a-z]{2}(?:-gov)?-[a-z]+-\d{1,2})?$")
    bedrock_endpoint: Literal["mantle", "runtime"] | None = None
    bedrock_model: str | None = Field(None, pattern=r"^[A-Za-z0-9._:/-]{0,200}$")
    # "" = no project (the account's default project). Mantle only.
    bedrock_project_id: str | None = Field(None, pattern=r"^[A-Za-z0-9_-]{0,128}$")
    bedrock_reasoning_effort: Literal["", "none", "low", "medium", "high"] | None = None
    bedrock_max_output_tokens: int | None = Field(None, ge=0, le=1_000_000)
    # Write-only. An empty string removes the stored key.
    bedrock_api_key: str | None = Field(None, max_length=4000)
    responses_base_url: str | None = Field(None, pattern=r"^https?://[^\s]+$", max_length=500)
    responses_model: str | None = Field(None, max_length=200)
    # Write-only. An empty string removes the stored key.
    responses_api_key: str | None = Field(None, max_length=1000)
    ollama_base_url: str | None = Field(None, pattern=r"^https?://[^\s]+$", max_length=500)
    ollama_model: str | None = Field(None, min_length=1, max_length=200)
    ollama_think: bool | None = None
    ollama_num_ctx: int | None = Field(None, ge=0, le=1_048_576)
    llm_max_content_chars: int | None = Field(None, ge=1_000, le=2_000_000)
    extra_scanners: list[Literal["bandit", "osv", "checkov"]] | None = None
    chains_enabled: bool | None = None
    chain_gate: bool | None = None
    verify_llm_findings: bool | None = None
    max_file_size_kb: int | None = Field(None, ge=1, le=10_240)
    max_files_per_repo: int | None = Field(None, ge=1, le=10_000)
    access_token_expire_minutes: int | None = Field(None, ge=5, le=10_080)
    worker_max_jobs: int | None = Field(None, ge=1, le=64)
    worker_job_timeout: int | None = Field(None, ge=60, le=86_400)
    repo_check_interval_hours: int | None = Field(None, ge=0, le=720)


class TestS1Request(BaseModel):
    console_url: str = Field(..., pattern=r"^https://[^\s/]+/?$", max_length=300)
    scope_type: Literal["ACCOUNT", "SITE"]
    scope_id: str = Field(..., pattern=r"^\d{1,30}$")
    api_token: str | None = Field(None, max_length=4000)


class TestBedrockRequest(BaseModel):
    region: str = Field(..., pattern=r"^[a-z]{2}(?:-gov)?-[a-z]+-\d{1,2}$")
    endpoint: Literal["mantle", "runtime"] = "mantle"
    project_id: str = Field("", pattern=r"^[A-Za-z0-9_-]{0,128}$")
    # The unsaved key from the form; otherwise the saved one is used.
    api_key: str | None = Field(None, max_length=4000)


class TourRequest(BaseModel):
    # true: finished or skipped (don't show again); false: show it again.
    done: bool


class SetRetentionRequest(BaseModel):
    scope: Literal["project", "account"]
    mode: Literal["inherit", "none", "default", "aws_review"]
    # Must be true for scope "account": it changes every Bedrock user in the account and Region.
    confirm_account: bool = False


class TestResponsesRequest(BaseModel):
    base_url: str = Field(..., pattern=r"^https?://[^\s]+$", max_length=500)
    api_key: str | None = Field(None, max_length=1000)
    # The admin confirmed plain HTTP for this host in the UI (not yet saved).
    allow_http: bool = False


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
    last_checked_at: datetime | None = None
    token_expires_at: datetime | None = None
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
