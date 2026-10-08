"""SentinelOne CNS layer: CLI invocation (against a fake s1-cns-cli), result
parsing, settings API, and worker integration."""
import functools
import json
import os
import stat
import sys

import httpx
import pytest
from sqlalchemy import select

from models import AppConfig
from tests.conftest import auth_headers, make_user
from worker.analysis.sentinelone import RepoMeta, S1Error, S1Settings, parse_results, run_sentinelone

TOKEN = "s1-service-user-" + "t" * 40
RAW_SECRET = "AKIAIOSFODNN7EXAMPLE-raw-secret-value"
CONSOLE = "https://usea1-test.sentinelone.net"

SECRET_ITEM = {
    "title": "AWS Access Key", "type": "AWS", "severity": "HIGH", "filePath": "config/aws.py",
    "isSecretVerified": False, "canVerify": True,
    "detectedSecret": {"value": RAW_SECRET, "patches": {"a": {"lines": [12, 14], "value": RAW_SECRET}}},
}
IAC_ITEM = {
    "title": "S3 bucket is public", "severity": "CRITICAL", "file_path": "infra/s3.tf",
    "code_start_line": 3, "code_end_line": 9, "code_block": 'acl = "public-read"',
    "description": "Bucket allows public reads.", "recommended_action": "Set acl to private.",
    "info_link": "https://docs.example/s3", "plugin_id": "AWS_S3_1", "block_name": "aws_s3_bucket.data",
}
VULN_ITEM = {
    "id": "CVE-2024-0001", "package": "requests", "version": "2.0.0", "severity": "MEDIUM",
    "fixedVersions": "2.32.0", "description": "Bad thing.", "link": "https://nvd.example/CVE-2024-0001",
    "paths": ["requirements.txt"], "CVSSScore": 5.5,
}

# A stand-in for s1-cns-cli: records each call, writes canned JSON results.
FAKE_CLI = r'''#!{python}
import json, os, sys
args = sys.argv[1:]
log = os.path.join(os.environ["HOME"], "calls.jsonl")
with open(log, "a") as f:
    f.write(json.dumps({{"args": args, "home": os.environ["HOME"]}}) + "\n")
mode = os.environ.get("FAKE_S1_MODE", "ok")
if "config" in args:
    cache = args[args.index("--cache-directory") + 1]
    os.makedirs(cache, exist_ok=True)
    tok = args[args.index("--service-user-api-token") + 1]
    json.dump({{"service_user_api_token": tok}}, open(os.path.join(cache, "config.json"), "w"))
    sys.exit(0)
crash = int(args[args.index("--on-crash-exit-code") + 1]) if "--on-crash-exit-code" in args else 97
scanner = args[args.index("scan") + 1]
if mode == "traceback":
    raise RuntimeError("unexpected")  # uncaught: exit 1, no output file
if mode == "crash" or (mode == "crash-iac" and scanner == "iac"):
    print("ERROR token {token} rejected by console")  # must be redacted
    sys.exit(97)
out = args[args.index("--output-file") + 1]
results = json.loads({payload!r})[scanner]
json.dump(results, open(out, "w"))
sys.exit(0)  # directory scans always exit 0
'''


@pytest.fixture
def fake_cli(tmp_path, monkeypatch):
    from config import settings

    cli = tmp_path / "s1-cns-cli"
    cli.write_text(FAKE_CLI.format(
        python=sys.executable, token=TOKEN,
        payload=json.dumps({"secret": [SECRET_ITEM], "iac": [IAC_ITEM], "vuln": {"findings": [VULN_ITEM]}}),
    ))
    cli.chmod(cli.stat().st_mode | stat.S_IEXEC)
    home = tmp_path / "s1home"
    monkeypatch.setattr(settings, "S1_CNS_CLI", str(cli))
    monkeypatch.setattr(settings, "S1_HOME", str(home))

    def calls():
        path = home / "calls.jsonl"
        return [json.loads(ln) for ln in path.read_text().splitlines()] if path.exists() else []

    return calls


def _cfg(**kw):
    return S1Settings(console_url=CONSOLE, scope_type="ACCOUNT", scope_id="123", token=TOKEN, **kw)


async def test_runs_all_scanners_with_safe_flags(fake_cli, tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    result = await run_sentinelone(str(repo), _cfg())
    assert {f.source for f in result.findings} == {"s1_secret", "s1_iac", "s1_vuln"}
    assert result.errors == []

    calls = fake_cli()
    config_call, *scan_calls = calls
    assert "config" in config_call["args"]
    assert config_call["args"][config_call["args"].index("--on-crash-exit-code") + 1] == "97"
    for call in calls:
        assert "--disable-sentry" in call["args"]
        assert call["home"] == str(tmp_path / "s1home")  # never the real HOME
    by_scanner = {c["args"][c["args"].index("scan") + 1]: c["args"] for c in scan_calls}
    assert "--disable-verification" in by_scanner["secret"] and "--mask-secret" in by_scanner["secret"]
    assert "--skip-external-modules" in by_scanner["iac"]
    assert not any("--publish-result" in a for a in by_scanner.values())
    assert oct((tmp_path / "s1home").stat().st_mode & 0o777) == "0o700"


async def test_config_only_reruns_when_settings_change(fake_cli, tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    await run_sentinelone(str(repo), _cfg(scanners=("vuln",)))
    await run_sentinelone(str(repo), _cfg(scanners=("vuln",)))
    assert sum("config" in c["args"] for c in fake_cli()) == 1
    await run_sentinelone(str(repo), S1Settings(CONSOLE, "SITE", "999", TOKEN, scanners=("vuln",)))
    assert sum("config" in c["args"] for c in fake_cli()) == 2


async def test_publish_only_for_iac_and_vuln(fake_cli, tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    await run_sentinelone(str(repo), _cfg(publish=True, verify_secrets=True),
                          RepoMeta(full_name="org/app", branch="feature"))
    by_scanner = {c["args"][c["args"].index("scan") + 1]: c["args"] for c in fake_cli() if "scan" in c["args"]}
    assert "--publish-result" not in by_scanner["secret"]
    assert "--disable-verification" not in by_scanner["secret"]  # verification opted in
    for scanner in ("iac", "vuln"):
        args = by_scanner[scanner]
        assert "--publish-result" in args
        assert args[args.index("--repo-url") + 1] == "https://github.com/org/app"
    assert by_scanner["iac"][by_scanner["iac"].index("--branch") + 1] == "feature"


async def test_crash_raises_and_redacts_token(fake_cli, tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()
    monkeypatch.setenv("FAKE_S1_MODE", "crash")
    with pytest.raises(S1Error) as exc:
        await run_sentinelone(str(repo), _cfg())
    assert TOKEN not in str(exc.value) and "rejected" in str(exc.value)


async def test_partial_failure_keeps_other_results(fake_cli, tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()
    monkeypatch.setenv("FAKE_S1_MODE", "crash-iac")
    result = await run_sentinelone(str(repo), _cfg())
    assert {f.source for f in result.findings} == {"s1_secret", "s1_vuln"}
    assert len(result.errors) == 1 and result.errors[0].startswith("iac:")
    assert TOKEN not in result.errors[0]


async def test_unexpected_exit_without_output_is_an_error(fake_cli, tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()
    monkeypatch.setenv("FAKE_S1_MODE", "traceback")
    with pytest.raises(S1Error, match="exited 1"):
        await run_sentinelone(str(repo), _cfg())


async def test_missing_cli_is_a_clear_error(tmp_path, monkeypatch):
    from config import settings

    monkeypatch.setattr(settings, "S1_CNS_CLI", "definitely-not-installed-s1-cli")
    with pytest.raises(S1Error, match="not found"):
        await run_sentinelone(str(tmp_path), _cfg())


# ── parsing ───────────────────────────────────────────────────────────────────

def test_secret_value_never_stored(tmp_path):
    [f] = parse_results("secret", [SECRET_ITEM], str(tmp_path))
    blob = json.dumps(f.__dict__)
    assert RAW_SECRET not in blob
    assert (f.severity, f.file_path, f.line_start, f.line_end) == ("high", "config/aws.py", 12, 14)
    assert "not verified" in f.description and "redacted" in f.description


def test_iac_and_vuln_mapping(tmp_path):
    [iac] = parse_results("iac", [IAC_ITEM], str(tmp_path))
    assert (iac.severity, iac.file_path, iac.line_start, iac.line_end) == ("critical", "infra/s3.tf", 3, 9)
    assert iac.code_snippet == 'acl = "public-read"' and "Set acl to private." in iac.remediation
    assert "aws_s3_bucket.data" in iac.description

    [vuln] = parse_results("vuln", {"findings": [VULN_ITEM]}, str(tmp_path))
    assert vuln.title == "requests 2.0.0: CVE-2024-0001" and vuln.severity == "medium"
    assert vuln.remediation.startswith("Upgrade to 2.32.0.")
    [nofix] = parse_results("vuln", [{**VULN_ITEM, "fixedVersions": ""}], str(tmp_path))
    assert nofix.remediation.startswith("No fixed version")


def test_absolute_paths_made_relative_and_junk_ignored(tmp_path):
    item = {**IAC_ITEM, "file_path": str(tmp_path / "infra" / "main.tf")}
    [f] = parse_results("iac", [item, "junk", 3], str(tmp_path))
    assert f.file_path == os.path.join("infra", "main.tf")
    assert parse_results("vuln", None, str(tmp_path)) == []


# ── settings API ──────────────────────────────────────────────────────────────

async def _admin(db):
    await make_user(db, "root", role="admin")
    return auth_headers("root")


async def test_enable_requires_console_scope_and_token(client, db):
    h = await _admin(db)
    resp = await client.patch("/settings/config", headers=h, json={"s1_enabled": True})
    assert resp.status_code == 422
    assert "console URL" in resp.text and "scope ID" in resp.text and "token" in resp.text

    ok = await client.patch("/settings/config", headers=h, json={
        "s1_enabled": True, "s1_console_url": CONSOLE + "/", "s1_scope_type": "ACCOUNT",
        "s1_scope_id": "123456789012345678", "s1_api_token": TOKEN, "s1_scanners": ["secret", "vuln"],
    })
    assert ok.status_code == 200, ok.text
    cfg = ok.json()
    assert cfg["s1_enabled"] and cfg["s1_console_url"] == CONSOLE and cfg["s1_scanners"] == ["secret", "vuln"]
    assert cfg["s1_token_set"] and cfg["s1_token_last4"] == TOKEN[-4:]
    assert TOKEN not in ok.text
    row = (await db.execute(select(AppConfig).where(AppConfig.key == "s1_api_token"))).scalar_one()
    assert TOKEN not in row.value  # encrypted at rest


@pytest.mark.parametrize("payload", [
    {"s1_console_url": "http://usea1.sentinelone.net"},     # https only
    {"s1_console_url": "https://x.net/web/api"},            # origin only, no path
    {"s1_scope_id": "abc"},
    {"s1_scope_type": "GROUP"},
    {"s1_scanners": ["secret", "malware"]},
    {"s1_scanners": []},
])
async def test_s1_settings_validation(client, db, payload):
    h = await _admin(db)
    assert (await client.patch("/settings/config", headers=h, json=payload)).status_code == 422


async def test_token_bound_to_console(client, db):
    h = await _admin(db)
    await client.patch("/settings/config", headers=h, json={
        "s1_console_url": CONSOLE, "s1_scope_id": "1", "s1_api_token": TOKEN})
    moved = await client.patch("/settings/config", headers=h,
                               json={"s1_console_url": "https://attacker.example"})
    assert moved.status_code == 422 and "bound to" in moved.text
    removed = await client.patch("/settings/config", headers=h, json={"s1_api_token": ""})
    assert removed.json()["s1_token_set"] is False


async def test_s1_connection_test(client, db, monkeypatch):
    from routers import settings as settings_router

    h = await _admin(db)
    await client.patch("/settings/config", headers=h, json={
        "s1_console_url": CONSOLE, "s1_scope_id": "1", "s1_api_token": TOKEN})
    seen = []

    def handler(request):
        seen.append((str(request.url), request.headers.get("Authorization")))
        # The real console rejects calls without the CLI's headers.
        if not request.headers.get("user-agent", "").startswith("s1-cns-cli-") \
                or not request.headers.get("x-runtime-arch"):
            return httpx.Response(400, json={"errors": [{"code": 400, "detail": "Missing required headers",
                                                         "title": "BAD_REQUEST"}]})
        if request.headers.get("Authorization") != f"Bearer {TOKEN}":
            return httpx.Response(401, json={})
        return httpx.Response(200, json={"data": {"version": "1.0.4"}})

    monkeypatch.setattr(settings_router.httpx, "AsyncClient",
                        functools.partial(httpx.AsyncClient, transport=httpx.MockTransport(handler)))
    body = {"console_url": CONSOLE, "scope_type": "ACCOUNT", "scope_id": "1"}
    ok = await client.post("/settings/config/test-s1", headers=h, json=body)
    assert ok.json() == {"ok": True, "cli_version": "1.0.4"}
    assert seen[0][0].startswith(CONSOLE + "/web/api/v2.1/cnapp/cli/latest-version")

    bad = await client.post("/settings/config/test-s1", headers=h, json={**body, "api_token": "wrong"})
    assert bad.json()["ok"] is False and "rejected" in bad.json()["error"]

    # The saved token is never sent to a different console.
    seen.clear()
    other = await client.post("/settings/config/test-s1", headers=h,
                              json={**body, "console_url": "https://attacker.example"})
    assert other.json()["ok"] is False and seen == []


# ── worker integration ────────────────────────────────────────────────────────

async def test_worker_layer_disabled_or_failing_never_breaks_analysis(db, client, monkeypatch):
    from app_config import load_app_config
    from worker import tasks

    class Sub:
        repo_full_name, branch = "org/app", "main"

    cfg = await load_app_config(db)
    assert await tasks._run_s1(db, cfg, "/tmp/x", Sub()) == ([], None)  # disabled → no-op

    h = await _admin(db)
    await client.patch("/settings/config", headers=h, json={
        "s1_enabled": True, "s1_console_url": CONSOLE, "s1_scope_id": "1", "s1_api_token": TOKEN})

    async def boom(*a, **kw):
        raise S1Error(f"config failed for {TOKEN}")

    monkeypatch.setattr(tasks, "run_sentinelone", boom)
    findings, note = await tasks._run_s1(db, await load_app_config(db), "/tmp/x", Sub())
    assert findings == [] and note.startswith("SentinelOne scan failed") and TOKEN not in note


async def test_s1_error_detail_is_surfaced(client, db, monkeypatch):
    from routers import settings as settings_router

    h = await _admin(db)
    monkeypatch.setattr(settings_router.httpx, "AsyncClient", functools.partial(
        httpx.AsyncClient, transport=httpx.MockTransport(lambda r: httpx.Response(
            400, json={"errors": [{"detail": "Invalid scope id", "title": "BAD_REQUEST"}]}))))
    resp = await client.post("/settings/config/test-s1", headers=h, json={
        "console_url": CONSOLE, "scope_type": "ACCOUNT", "scope_id": "1", "api_token": TOKEN})
    assert resp.json() == {"ok": False, "error": "HTTP 400: Invalid scope id"}


def test_s1_cli_version_pinned_consistently():
    """Dockerfile, launcher and API must agree on the CLI version."""
    import re

    from config import settings
    from tests.test_launcher import ROOT

    docker = re.search(r"ARG S1_CLI_VERSION=(\S+)", (ROOT / "Dockerfile").read_text()).group(1)
    launcher = re.search(r'S1_CLI_VERSION = "([^"]+)"', (ROOT / "custos").read_text()).group(1)
    assert docker == launcher == settings.S1_CLI_VERSION


def test_scan_errors_show_the_error_not_warnings():
    from worker.analysis.sentinelone import _scan_error

    out = ("WARNING\tThreshold is set to LOW by default. You can change it using --threshold flag.\n"
           "ERROR\tsomething broke\n")
    assert _scan_error("iac", out) == "iac: ERROR something broke"


def test_disabled_scanner_is_explained():
    from worker.analysis.sentinelone import _scan_error

    out = "WARNING\tThreshold is set to LOW by default.\nERROR\tvuln scan is disabled\n"
    msg = _scan_error("vuln", out)
    assert "policy ID" in msg and "Settings" in msg


async def test_policy_id_is_configured_and_changes_reconfigure(fake_cli, tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()

    def config_calls():
        return [c["args"] for c in fake_cli() if "config" in c["args"]]

    await run_sentinelone(str(repo), _cfg())
    assert "--policy-id" not in config_calls()[-1]  # unset: CLI default (secret only)

    await run_sentinelone(str(repo), _cfg(policy_id="pol-1"))
    args = config_calls()[-1]
    assert len(config_calls()) == 2 and args[args.index("--policy-id") + 1] == "pol-1"

    await run_sentinelone(str(repo), _cfg(policy_id="pol-1"))
    assert len(config_calls()) == 2  # unchanged settings: no reconfigure


async def test_policy_id_setting_round_trip(client, db):
    from tests.conftest import auth_headers, make_user

    await make_user(db, "root", role="admin")
    h = auth_headers("root")
    bad = await client.patch("/settings/config", json={"s1_policy_id": "x; rm -rf /"}, headers=h)
    assert bad.status_code == 422
    ok = await client.patch("/settings/config", json={"s1_policy_id": "pol-1"}, headers=h)
    assert ok.status_code == 200 and ok.json()["s1_policy_id"] == "pol-1"
    cleared = await client.patch("/settings/config", json={"s1_policy_id": ""}, headers=h)
    assert cleared.json()["s1_policy_id"] == ""
