#!/usr/bin/env python3
"""Reset local DEX trader accounts. Defaults to a read-only preview."""

import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from uuid import UUID

ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP_ENV = ROOT / "docker/env/bootstrap.env"
KEYCLOAK_URL = "http://localhost:18082"
REALM = "Dex"
ISSUER = f"{KEYCLOAK_URL}/realms/{REALM}"
OPERATOR_SUBJECT = "00000000-0000-0000-0000-000000000003"
# The backend's JWT clock tolerance (backend/src/iam/authentication.ts).
JWT_CLOCK_SKEW_SECONDS = 60


def local_credentials():
    values = {}
    for line in BOOTSTRAP_ENV.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, value = line.split("=", 1)
        parts = shlex.split(value, comments=True)
        if len(parts) != 1:
            raise ValueError(f"Invalid value for {key.strip()} in {BOOTSTRAP_ENV.relative_to(ROOT)}")
        values[key.strip()] = parts[0]
    keys = ("DEX_BOOTSTRAP_KEYCLOAK_USERNAME", "DEX_BOOTSTRAP_KEYCLOAK_PASSWORD")
    return tuple(os.environ.get(key) or values[key] for key in keys)


def compose(*arguments, stdin=None):
    command = ["docker", "compose", "--project-name", "canton-dex", "-f", str(ROOT / "docker/compose.dev.yaml")]
    result = subprocess.run(
        command + list(arguments), cwd=ROOT, input=stdin, text=True,
        capture_output=True, timeout=180,
    )
    if result.returncode:
        raise RuntimeError(f"Docker command failed: {' '.join(arguments[:3])}\n{result.stderr.strip()}")
    return result.stdout


class Keycloak:
    def __init__(self, username, password, realm=REALM):
        self.username, self.password, self.realm = username, password, realm
        self.token = None
        self.token_until = 0

    def _request(self, method, path, payload=None, expected=(200,), form=False, token=None):
        body = None if payload is None else (
            urlencode(payload).encode() if form else json.dumps(payload).encode()
        )
        headers = {"Content-Type": "application/x-www-form-urlencoded" if form else "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = Request(KEYCLOAK_URL + path, data=body, headers=headers, method=method)
        try:
            with urlopen(request, timeout=15) as response:
                status, data = response.status, response.read()
        except HTTPError as error:
            status, data = error.code, b""
            error.close()
        if status not in expected:
            # Never include the request body, bearer token or response credentials.
            raise RuntimeError(f"Keycloak {method} {path} returned HTTP {status}")
        return json.loads(data) if data else None

    def admin(self, method, path, payload=None, expected=(200,)):
        if time.monotonic() >= self.token_until:
            answer = self._request(
                "POST", "/realms/master/protocol/openid-connect/token",
                {"client_id": "admin-cli", "grant_type": "password",
                 "username": self.username, "password": self.password}, form=True,
            )
            self.token = answer["access_token"]
            self.token_until = time.monotonic() + max(0, answer["expires_in"] - 10)
        return self._request(method, path, payload, expected, token=self.token)

    def request(self, method, path="", payload=None, expected=(200,)):
        return self.admin(method, f"/admin/realms/{quote(self.realm, safe='')}" + path, payload, expected)

    def users(self):
        users, seen = [], set()
        while True:
            page = self.request("GET", f"/users?first={len(users)}&max=100&briefRepresentation=false")
            if not page:
                return users
            for user in page:
                if user["id"] in seen:
                    raise RuntimeError("Keycloak pagination repeated a user; retry the preview")
                seen.add(user["id"])
                users.append(user)

    def token_window(self):
        realm = self.request("GET")
        lifetime = int(realm["accessTokenLifespan"])
        if lifetime <= 0:
            raise RuntimeError("A finite realm access-token lifetime is required")
        for client in self.request("GET", "/clients"):
            if not client.get("enabled", True):
                continue
            override = int(client.get("attributes", {}).get("access.token.lifespan") or 0)
            if override < 0:
                raise RuntimeError(f"Client {client['clientId']} has no bounded token lifetime")
            lifetime = max(lifetime, override)
            if client.get("implicitFlowEnabled"):
                implicit = int(realm["accessTokenLifespanForImplicitFlow"])
                if implicit <= 0:
                    raise RuntimeError("A finite implicit-flow token lifetime is required")
                lifetime = max(lifetime, implicit)
        return lifetime + JWT_CLOCK_SKEW_SECONDS

    def delete_user(self, subject):
        path = "/users/" + quote(subject, safe="")
        self.request("POST", path + "/logout", expected=(204, 404))
        self.request("DELETE", path, expected=(204, 404))


def sql_string(value):
    if "\0" in value:
        raise ValueError("NUL is not allowed in SQL values")
    return "'" + value.replace("'", "''") + "'"


def uuid_array(accounts):
    return "ARRAY[" + ",".join(sql_string(str(UUID(a["id"]))) for a in accounts) + "]::uuid[]"


class Database:
    def __init__(self, name="dex", issuer=ISSUER):
        self.name, self.issuer = name, issuer

    def sql(self, query):
        return compose("exec", "-T", "app-db", "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
                       "-U", "dex", "-d", self.name, stdin=query)

    def accounts(self):
        return json.loads(self.sql("""
            SELECT COALESCE(json_agg(a), '[]'::json) FROM
            (SELECT id, issuer, subject, display_name, role FROM accounts ORDER BY id) a;
        """))

    def counts(self, accounts):
        return json.loads(self.sql(f"""
            SELECT json_build_object(
                'onboardings', (SELECT count(*) FROM onboardings WHERE account_id = ANY({uuid_array(accounts)})),
                'steps', (SELECT count(*) FROM onboarding_steps s JOIN onboardings o ON s.onboarding_id=o.id
                          WHERE o.account_id = ANY({uuid_array(accounts)})));
        """))

    def delete_accounts(self, accounts):
        return json.loads(self.sql(f"""
            BEGIN;
            SET LOCAL lock_timeout = '5s';
            LOCK TABLE accounts, onboardings, onboarding_steps IN EXCLUSIVE MODE;
            CREATE TEMP TABLE reset_user_targets ON COMMIT DROP AS
                SELECT id FROM accounts WHERE id = ANY({uuid_array(accounts)})
                AND issuer = {sql_string(self.issuer)} AND role = 'TRADER'
                AND subject <> {sql_string(OPERATOR_SUBJECT)};
            DELETE FROM onboarding_steps USING onboardings o, reset_user_targets t
                WHERE onboarding_steps.onboarding_id=o.id AND o.account_id=t.id;
            DELETE FROM onboardings USING reset_user_targets t WHERE onboardings.account_id=t.id;
            WITH deleted AS (DELETE FROM accounts USING reset_user_targets t
                WHERE accounts.id=t.id RETURNING accounts.id)
            SELECT COALESCE(json_agg(id), '[]'::json) FROM deleted;
            COMMIT;
        """))


def deletion_plan(users, accounts, issuer=ISSUER):
    protected = {OPERATOR_SUBJECT}
    protected.update(a["subject"] for a in accounts if a["issuer"] == issuer and a["role"] != "TRADER")
    protected.update(u["id"] for u in users if u.get("username", "").casefold() == "operator"
                     or u.get("serviceAccountClientId") or u.get("username", "").startswith("service-account-"))
    return {
        "users": sorted((u for u in users if u["id"] not in protected), key=lambda u: u["id"]),
        "accounts": sorted((a for a in accounts if a["issuer"] == issuer and a["role"] == "TRADER"
                            and a["subject"] not in protected), key=lambda a: a["id"]),
    }


def wait_for_tokens(seconds):
    deadline = time.monotonic() + seconds
    while (remaining := deadline - time.monotonic()) > 0:
        print(f"Waiting for old access tokens: {int(remaining) + 1}s remaining", flush=True)
        time.sleep(min(30, remaining))


def clear_users(keycloak, database, plan, wait=wait_for_tokens):
    # Check the lifetime before deleting anything. Wait after the LAST identity is deleted.
    seconds = keycloak.token_window()
    for user in plan["users"]:
        keycloak.delete_user(user["id"])
    wait(seconds)
    return database.delete_accounts(plan["accounts"])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", help="delete the previewed trader accounts")
    parser.add_argument("--yes", action="store_true", help="skip the interactive confirmation (requires --execute)")
    args = parser.parse_args(argv)
    if args.yes and not args.execute:
        parser.error("--yes requires --execute")
    keycloak, database = Keycloak(*local_credentials()), Database()
    plan = deletion_plan(keycloak.users(), database.accounts())
    counts = database.counts(plan["accounts"])
    print(f"Local realm {REALM}: {len(plan['users'])} users, {len(plan['accounts'])} database accounts, "
          f"{counts['onboardings']} onboardings, {counts['steps']} ledger-step records.")
    for user in plan["users"]:
        print(f"  {json.dumps(user.get('username', user['id']))} ({user['id']})")
    print("Preserved: operators, service accounts, other realms, pools, Canton parties/contracts and wallet keys.")
    if not plan["users"] and not plan["accounts"]:
        print("Nothing to delete.")
        return
    seconds = keycloak.token_window()
    print(f"Execution pauses the backend for at least {seconds}s to expire existing tokens.")
    if not args.execute:
        print("Preview only. Run again with --execute to delete these accounts.")
        return
    if not args.yes:
        if not sys.stdin.isatty() or input("Type DELETE to continue: ") != "DELETE":
            raise RuntimeError("Cancelled; no accounts deleted. Use --execute --yes for non-interactive runs.")
    running = "backend" in compose("ps", "--status", "running", "--services").splitlines()
    if running:
        compose("stop", "backend")
    deleting = False
    completed = False
    try:
        fresh = deletion_plan(keycloak.users(), database.accounts())
        if fresh != plan:
            raise RuntimeError("Users changed since the preview. Retry; no accounts deleted.")
        deleting = True
        deleted = clear_users(keycloak, database, plan)
        completed = True
        print(f"Deleted {len(plan['users'])} Keycloak users and {len(deleted)} database accounts with their onboardings.")
    finally:
        if running and (completed or not deleting):
            compose("start", "--wait", "--wait-timeout", "120", "backend")
        elif deleting and not completed:
            print("Cleanup interrupted; backend remains stopped. Rerun the utility, then make docker-run.", file=sys.stderr)
    print("Sign in with a new registration. For a new Canton party, choose another party name or wallet key index.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, KeyError, OSError, URLError, subprocess.TimeoutExpired, KeyboardInterrupt) as error:
        print(f"Reset failed: {error or 'interrupted'}", file=sys.stderr)
        sys.exit(1)
