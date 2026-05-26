from datetime import datetime
from typing import Optional
from uuid import UUID
from pydantic import BaseModel


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
    branch: Optional[str] = None
    submitter: Optional[str] = None
    event_type: Optional[str] = None
    pr_number: Optional[int] = None
    status: str
    error_message: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class SubmissionListResponse(BaseModel):
    submissions: list[SubmissionResponse]
    total: int


class FindingResponse(BaseModel):
    id: UUID
    submission_id: UUID
    source: str
    severity: str
    cwe: Optional[str] = None
    title: str
    description: Optional[str] = None
    file_path: Optional[str] = None
    line_start: Optional[int] = None
    line_end: Optional[int] = None
    code_snippet: Optional[str] = None
    remediation: Optional[str] = None
    llm_reasoning: Optional[str] = None
    disposition: Optional[str] = None
    disposed_by: Optional[str] = None
    disposed_at: Optional[datetime] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class DispositionRequest(BaseModel):
    disposition: str  # confirmed | false_positive | escalated
    note: Optional[str] = None


class SignoffRequest(BaseModel):
    note: Optional[str] = None


class AuditLogResponse(BaseModel):
    id: UUID
    submission_id: UUID
    finding_id: Optional[UUID] = None
    analyst: str
    action: str
    note: Optional[str] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class WebhookResponse(BaseModel):
    status: str
    submission_id: Optional[str] = None


# Settings schemas

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class CreateUserRequest(BaseModel):
    username: str
    password: str
    role: str = "analyst"


class UserListResponse(BaseModel):
    id: UUID
    username: str
    role: str
    created_at: datetime

    model_config = {"from_attributes": True}


class UpdateUserRoleRequest(BaseModel):
    role: str


class GitHubConfigResponse(BaseModel):
    webhook_secret_set: bool
    webhook_secret_preview: str
    token_set: bool
    token_preview: str


class GitHubConfigUpdateRequest(BaseModel):
    webhook_secret: Optional[str] = None
    token: Optional[str] = None


class AppConfigResponse(BaseModel):
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
    ollama_base_url: Optional[str] = None
    ollama_model: Optional[str] = None
    ollama_think: Optional[bool] = None
    ollama_num_ctx: Optional[int] = None
    llm_max_content_chars: Optional[int] = None
    max_file_size_kb: Optional[int] = None
    max_files_per_repo: Optional[int] = None
    access_token_expire_minutes: Optional[int] = None
    worker_max_jobs: Optional[int] = None
    worker_job_timeout: Optional[int] = None
