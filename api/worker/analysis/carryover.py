"""Carry analysts' false-positive decisions forward to later scans of a repo.

The LLM reports slightly different findings on every run, so without this an
analyst would dismiss the same false positive again after each scan. Matching
is deliberately conservative: a real issue wrongly auto-dismissed is worse
than one extra finding to review.
"""

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from enums import Disposition, Severity
from models import AuditLog, Finding, Submission
from worker.analysis.synthesizer import _is_semantic_dup, _sig_words

_LINE_WINDOW = 15
_MAX_DECISIONS = 1000
_RANK = {s.value: i for i, s in enumerate(Severity)}  # critical=0 … info=4
AUTO_ANALYST = "custos"


def _near(a: int | None, b: int | None) -> bool:
    return a is not None and b is not None and abs(a - b) <= _LINE_WINDOW


def is_same_issue(new: dict, old: Finding) -> bool:
    """True if *new* (a synthesize() dict) is plausibly the issue *old* was about."""
    if (new.get("file_path") or "").lower() != (old.file_path or "").lower():
        return False
    if (new["source"] == "llm") != (old.source == "llm"):
        return False
    if new["source"] != "llm":
        if new["source"] != old.source or new["title"] != old.title:
            return False
        if new.get("line_start") is None and old.line_start is None:
            return True  # e.g. dependency or config findings
        same_code = bool(new.get("code_snippet")) and new.get("code_snippet") == old.code_snippet
        return same_code or _near(new.get("line_start"), old.line_start)
    # LLM wording varies between runs: same place, and same weakness or topic.
    if not (_near(new.get("line_start"), old.line_start)
            or (new.get("line_start") is None and old.line_start is None and new["title"] == old.title)):
        return False
    if new.get("cwe") and old.cwe and new["cwe"] == old.cwe:
        return True
    return _is_semantic_dup(_sig_words(new["title"]), _sig_words(old.title))


async def apply_previous_false_positives(
    db: AsyncSession, repo_full_name: str, findings: list[dict]
) -> list[tuple[dict, Finding]]:
    """Mark findings an analyst already dismissed in an earlier scan of the repo.

    The most recent matching decision wins, so a later "confirmed" stops the
    carry-over. Never applied when the new finding is more severe. Mutates the
    dicts and returns (new, previous) pairs for the audit log.
    """
    rows = await db.execute(
        select(Finding)
        .join(Submission, Finding.submission_id == Submission.id)
        .where(Submission.repo_full_name == repo_full_name, Finding.disposition.is_not(None))
        .order_by(Finding.disposed_at.desc())
        .limit(_MAX_DECISIONS)
    )
    decisions = rows.scalars().all()
    carried: list[tuple[dict, Finding]] = []
    now = datetime.now(UTC)
    for f in findings:
        old = next((d for d in decisions if is_same_issue(f, d)), None)
        if old is None or old.disposition != Disposition.FALSE_POSITIVE:
            continue
        if _RANK.get(f["severity"], 0) < _RANK.get(old.severity, 0):
            continue
        f["disposition"] = Disposition.FALSE_POSITIVE.value
        f["disposed_by"] = f"auto: {old.disposed_by or 'unknown'}"
        f["disposed_at"] = now
        carried.append((f, old))
    return carried


def audit_carried(db: AsyncSession, submission_id, carried: list[tuple[Finding, Finding]]) -> None:
    for new, old in carried:
        when = old.disposed_at.date().isoformat() if old.disposed_at else "an earlier scan"
        db.add(AuditLog(
            submission_id=submission_id,
            finding_id=new.id,
            analyst=AUTO_ANALYST,
            action=Disposition.FALSE_POSITIVE.value,
            note=(f"Carried forward: {old.disposed_by or 'an analyst'} marked a matching finding "
                  f"a false positive on {when} (finding {old.id})."),
        ))
