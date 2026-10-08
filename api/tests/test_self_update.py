"""Self-update: the review gate (API + manage.py) and ./custos update's
decision logic, run against real temporary git repositories."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from models import AppConfig, AuditLog
from tests.conftest import auth_headers, make_repo, make_submission, make_user
from tests.test_launcher import ROOT, _load_launcher

SHA = "a" * 40  # make_submission's commit


# ── settings + sign-off ───────────────────────────────────────────────────────

async def test_self_update_repo_must_be_registered(client, db):
    await make_user(db, "root", role="admin")
    h = auth_headers("root")
    assert (await client.patch("/settings/config", headers=h,
                               json={"self_update_repo": "org/unknown"})).status_code == 422
    await make_repo(db, "org/custos", owner="root")
    ok = await client.patch("/settings/config", headers=h, json={"self_update_repo": "org/custos"})
    assert ok.json()["self_update_repo"] == "org/custos"
    off = await client.patch("/settings/config", headers=h, json={"self_update_repo": ""})
    assert off.json()["self_update_repo"] == ""


async def test_only_admins_sign_off_custos_itself(client, db):
    await make_user(db, "root", role="admin")
    await make_user(db, "ana")  # analyst who owns the repo, so can see it
    await make_repo(db, "org/custos", owner="ana")
    sub = await make_submission(db, "org/custos")
    db.add(AppConfig(key="self_update_repo", value="org/custos", updated_by="root"))
    await db.commit()

    detail = await client.get(f"/submissions/{sub.id}", headers=auth_headers("ana"))
    assert detail.json()["is_self_update"] is True
    denied = await client.post(f"/submissions/{sub.id}/signoff", headers=auth_headers("ana"), json={})
    assert denied.status_code == 403 and "approves deploying" in denied.text
    ok = await client.post(f"/submissions/{sub.id}/signoff", headers=auth_headers("root"), json={})
    assert ok.status_code == 200


# ── manage.py self-update-status ──────────────────────────────────────────────

def _status(sha=SHA):
    res = subprocess.run([sys.executable, str(ROOT / "api" / "manage.py"), "self-update-status", sha],
                         capture_output=True, text=True, env=os.environ.copy())
    return res.returncode, json.loads(res.stdout.strip().splitlines()[-1])


async def _self_repo_submission(db, *, signed_by=None, findings=()):
    await make_repo(db, "org/custos", owner="root")
    db.add(AppConfig(key="self_update_repo", value="org/custos", updated_by="root"))
    sub = await make_submission(db, "org/custos", status="signed_off" if signed_by else "needs_review",
                                findings=list(findings))
    if signed_by:
        db.add(AuditLog(submission_id=sub.id, analyst=signed_by, action="sign_off"))
    await db.commit()
    return sub


async def test_status_requires_configuration_and_a_scan(db):
    rc, out = _status()
    assert rc == 1 and "No self-update repo" in out["reason"]
    await make_user(db, "root", role="admin")
    await _self_repo_submission(db)
    rc, out = _status("b" * 40)
    assert rc == 1 and "has not scanned this commit" in out["reason"]
    rc, out = _status()
    assert rc == 1 and "Not signed off" in out["reason"]


async def test_admin_sign_off_approves(db):
    await make_user(db, "root", role="admin")
    await _self_repo_submission(db, signed_by="root",
                                findings=[{"severity": "high", "disposition": "false_positive"}])
    rc, out = _status()
    assert rc == 0 and out["approved"] is True and out["signed_off_by"] == "root"


async def test_analyst_sign_off_does_not_approve(db):
    """E.g. signed off before the repo was designated as Custos itself."""
    await make_user(db, "root", role="admin")
    await make_user(db, "ana")
    await _self_repo_submission(db, signed_by="ana")
    rc, out = _status()
    assert rc == 1 and "not by an admin" in out["reason"]


@pytest.mark.parametrize("disposition", ["confirmed", "escalated"])
async def test_confirmed_blocking_finding_blocks_update(db, disposition):
    await make_user(db, "root", role="admin")
    await _self_repo_submission(db, signed_by="root",
                                findings=[{"severity": "critical", "disposition": disposition}])
    rc, out = _status()
    assert rc == 1 and "confirmed as real" in out["reason"]


# ── launcher helpers ──────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def custos():
    return _load_launcher()


@pytest.mark.parametrize("url,expected", [
    ("https://github.com/halicea7/CUSTOS.git", "halicea7/CUSTOS"),
    ("https://github.com/halicea7/CUSTOS", "halicea7/CUSTOS"),
    ("git@github.com:halicea7/CUSTOS.git", "halicea7/CUSTOS"),
    ("ssh://git@github.com/halicea7/CUSTOS.git", "halicea7/CUSTOS"),
    ("https://gitlab.com/x/y.git", None),
    ("https://github.com.evil.example/x/y", None),
])
def test_github_repo_from_remote(custos, url, expected):
    assert custos.github_repo_from_remote(url) == expected


def test_ci_verdict(custos):
    ok_run = {"name": "backend", "status": "completed", "conclusion": "success"}
    custos_run = {"name": "Custos Security Review", "status": "completed", "conclusion": "success"}
    assert custos.ci_verdict([ok_run, custos_run])[0] is True
    # Custos's own check doesn't count as CI (review is checked via the database).
    assert custos.ci_verdict([custos_run]) == (False, "no CI check runs found for this commit")
    assert custos.ci_verdict([ok_run, {"name": "docker", "status": "in_progress"}])[1].startswith("CI still running")
    assert custos.ci_verdict([ok_run, {"name": "deploy", "status": "completed", "conclusion": "failure"}]) \
        == (False, "CI failed: deploy")


# ── cmd_update end to end (git real; Docker/GitHub stubbed) ───────────────────

def _git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def _commit(cwd, name, content="x"):
    (Path(cwd) / name).write_text(content)
    _git(cwd, "add", name)
    _git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", name)
    return _git(cwd, "rev-parse", "HEAD")


class Updater:
    """A deployed checkout plus an origin to push "upstream" commits to."""

    def __init__(self, tmp_path, custos, monkeypatch):
        self.custos = custos
        self.origin = tmp_path / "origin.git"
        self.upstream = tmp_path / "upstream"
        self.deploy = tmp_path / "deploy"
        _git(tmp_path, "init", "-q", "--bare", "-b", "main", str(self.origin))
        _git(tmp_path, "clone", "-q", str(self.origin), str(self.upstream))
        _git(self.upstream, "checkout", "-q", "-b", "main")
        self.v1 = _commit(self.upstream, "app.py", "v1")
        _git(self.upstream, "push", "-q", "origin", "main")
        _git(tmp_path, "clone", "-q", "-b", "main", str(self.origin), str(self.deploy))
        (self.deploy / ".env").write_text("POSTGRES_USER=custos\n")

        self.ci = (True, "CI passed")
        self.review = {"approved": True, "signed_off_by": "root"}
        self.healthy = [True]  # successive _healthy() results
        self.schema = ["0006", "0006"]  # alembic versions before / after deploy
        self.restored = []
        self.ups = 0

        monkeypatch.setattr(custos, "ROOT", self.deploy)
        monkeypatch.setattr(custos, "DOCKER_ENV", self.deploy / ".env")
        monkeypatch.setattr(custos, "compose_cmd", lambda: ["docker", "compose"])
        monkeypatch.setattr(custos, "github_repo_from_remote", lambda url: "org/custos")
        monkeypatch.setattr(custos, "_check_runs", lambda repo, sha: [])
        monkeypatch.setattr(custos, "ci_verdict", lambda runs: self.ci)
        monkeypatch.setattr(custos, "_review_status", lambda compose, sha: self.review)
        monkeypatch.setattr(custos, "_alembic_version", lambda compose: self.schema.pop(0))
        monkeypatch.setattr(custos, "_backup_db", lambda compose, label: self.deploy / "backups" / "b.dump")
        monkeypatch.setattr(custos, "_restore_db", lambda compose, path: self.restored.append(path))
        monkeypatch.setattr(custos, "_healthy", lambda compose: self.healthy.pop(0))

        def fake_run(cmd, **kw):
            if cmd[-4:] == ["up", "-d", "--build", "--remove-orphans"]:
                self.ups += 1
            return subprocess.CompletedProcess(cmd, 0, "", "")

        monkeypatch.setattr(custos, "run", fake_run)

    def push(self, name="feature.py"):
        sha = _commit(self.upstream, name)
        _git(self.upstream, "push", "-q", "origin", "main")
        return sha

    def head(self):
        return _git(self.deploy, "rev-parse", "HEAD")

    def update(self, check=False):
        class Args:
            pass
        Args.check = check
        self.custos.cmd_update(Args)


@pytest.fixture
def updater(tmp_path, custos, monkeypatch):
    return Updater(tmp_path, custos, monkeypatch)


def test_up_to_date_does_nothing(updater):
    updater.update()
    assert updater.head() == updater.v1 and updater.ups == 0


def test_deploys_when_all_gates_pass(updater):
    v2 = updater.push()
    updater.update(check=True)
    assert updater.head() == updater.v1  # --check changes nothing
    updater.update()
    assert updater.head() == v2 and updater.ups == 1 and updater.restored == []


@pytest.mark.parametrize("gate", ["ci", "review"])
def test_failing_gate_blocks_deploy(updater, gate):
    updater.push()
    if gate == "ci":
        updater.ci = (False, "CI failed: backend")
    else:
        updater.review = {"approved": False, "reason": "Not signed off yet"}
    updater.update()  # pending, not an error (cron-friendly exit 0)
    assert updater.head() == updater.v1 and updater.ups == 0
    with pytest.raises(SystemExit) as exc:
        updater.update(check=True)
    assert exc.value.code == 2


def test_refuses_rewritten_history(updater):
    # Replace main with an unrelated commit (force-push).
    _git(updater.upstream, "checkout", "-q", "--orphan", "evil")
    _commit(updater.upstream, "evil.py")
    _git(updater.upstream, "push", "-q", "-f", "origin", "evil:main")
    with pytest.raises(SystemExit):
        updater.update()
    assert updater.head() == updater.v1 and updater.ups == 0


def test_refuses_local_modifications(updater):
    updater.push()
    (updater.deploy / "app.py").write_text("hotfix")
    with pytest.raises(SystemExit):
        updater.update()
    assert updater.ups == 0


def test_unhealthy_deploy_rolls_back_code_and_schema(updater):
    updater.push()
    updater.healthy = [False, True]          # new version unhealthy, rollback healthy
    updater.schema = ["0006", "0007"]        # the update migrated the schema
    with pytest.raises(SystemExit):
        updater.update()
    assert updater.head() == updater.v1      # code rolled back
    assert len(updater.restored) == 1        # database restored from the backup
    assert updater.ups == 2                  # new version, then the rollback


def test_unhealthy_deploy_without_schema_change_keeps_database(updater):
    updater.push()
    updater.healthy = [False, True]
    with pytest.raises(SystemExit):
        updater.update()
    assert updater.head() == updater.v1 and updater.restored == []
