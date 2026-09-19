# Local user reset

Requires Python 3 and the running local Keycloak and application Postgres services.
Credentials are read from `docker/bootstrap.env` or the corresponding
`DEX_BOOTSTRAP_KEYCLOAK_USERNAME` / `DEX_BOOTSTRAP_KEYCLOAK_PASSWORD` environment variables.

Preview from the repository root:

```sh
python3 scripts/utils/reset-users.py
```

Delete the previewed users after typing `DELETE`:

```sh
python3 scripts/utils/reset-users.py --execute
```

Use `--execute --yes` for an explicitly confirmed, non-interactive run.
The utility deletes regular users in the local `Dex` realm, their Postgres accounts,
onboarding applications, document metadata, preparations and ledger-step records.
It preserves all database operators, the built-in `operator`, service accounts,
other realms, Canton fixture identities, pools and venue configuration.
Regular seed traders such as Alice and Bob are included in the reset.

The backend is paused while deleting identities and draining existing access tokens
(currently 300 seconds plus 60 seconds of clock tolerance). It resumes only after
the database transaction commits, if it was running before. This prevents a still-valid
token from recreating a deleted account. If cleanup fails or is interrupted, rerun
the utility before `make docker-run`; already-deleted Keycloak users are harmless.
Close old trader tabs and register again when cleanup finishes.

Canton API users, parties, contracts and wallet keys are not deleted. For another
fresh external party, choose a different party name or wallet key index. This utility
resets web accounts and onboarding records, not the ledger.

Validation uses a disposable Keycloak realm and Postgres database; it does not delete
current users or stop the current backend:

```sh
DEX_RESET_USERS_INTEGRATION=1 python3 -m unittest discover -s scripts/utils -p 'test_*.py' -v
```
