import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "dex-reset.sh"


class DexResetTest(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        (self.root / "scripts").mkdir()
        shutil.copy2(SCRIPT, self.root / "scripts/dex-reset.sh")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "commands.jsonl"
        self.env = {
            k: v for k, v in os.environ.items()
            if not k.startswith(("DOCKER_", "COMPOSE_"))
        }
        self.env.update(PATH=f"{self.bin}:{self.env['PATH']}", RESET_TEST_ROOT=str(self.root))
        self.env.update(COMPOSE_PROJECT_NAME="unrelated", COMPOSE_FILE="unrelated.yaml")
        self.keep = ["contracts/dars/vendor.dar", "backend/src/Keep.java", "frontend/dev/canton-snap/dist/bundle.js"]
        self.keep += ["contracts/.daml/dist/current.dar", "backend/build/app.jar", "backend/.gradle/cache", "client/dist/index.js", "frontend/dist/index.js"]
        self.state_volumes = ["application-postgres", "localnet-postgres", "domain-upgrade-dump"]
        for name in self.keep + [f"volumes/{v}/data" for v in self.state_volumes + ["gradle-cache"]]:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("sentinel")
        docker = self.bin / "docker"
        docker.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
r = Path(os.environ["RESET_TEST_ROOT"])
a = sys.argv[1:]
with (r / "commands.jsonl").open("a") as f:
    f.write(json.dumps(a) + "\\n")
if a[:2] == ["context", "inspect"]:
    print("unix:///local/docker.sock")
elif a and a[0] == "stop":
    if os.environ.get("RESET_TEST_STOP_FAIL"):
        sys.exit(23)
    (r / "stopped").touch()
elif a and a[0] == "ps":
    if "-a" in a or not (r / "stopped").exists() or os.environ.get("RESET_TEST_STILL_RUNNING"):
        print("canton-dex-backend-1")
elif a[:2] == ["volume", "ls"]:
    name = next(v.split("=", 2)[2] for v in a if v.startswith("label=com.docker.compose.volume="))
    print("canton-dex_" + name)
elif a and a[0] == "run":
    if os.environ.get("RESET_TEST_CLEAR_FAIL"):
        sys.exit(24)
    mount = a[a.index("--mount") + 1]
    volume = next(v.split("=", 1)[1] for v in mount.split(",") if v.startswith("source="))
    (r / "volumes" / volume.removeprefix("canton-dex_") / "data").unlink(missing_ok=True)
''')
        docker.chmod(0o755)

    def run_reset(self, *args, answer="", env=None):
        return subprocess.run(
            ["bash", str(self.root / "scripts/dex-reset.sh"), *args],
            cwd=self.bin, env=env or self.env, input=answer,
            text=True, capture_output=True,
        )

    def commands(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def assert_untouched(self):
        self.assertTrue(all((self.root / name).exists() for name in self.keep))
        self.assertTrue(all((self.root / "volumes" / name / "data").exists() for name in self.state_volumes))
        self.assertFalse(any(a[0] in ("compose", "stop", "run", "rm") for a in self.commands()))

    def test_preview_changes_nothing(self):
        self.assertEqual(self.run_reset("--dry-run").returncode, 0)
        self.assert_untouched()

    def test_cancel_and_closed_stdin_change_nothing(self):
        for answer in ("no\n", ""):
            self.assertNotEqual(self.run_reset(answer=answer).returncode, 0)
            self.assert_untouched()

    def test_remote_docker_is_rejected_before_any_command(self):
        result = self.run_reset("--yes", env=dict(self.env, DOCKER_HOST="tcp://remote:2376"))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.commands(), [])
        self.assert_untouched()

    def test_stop_failure_prevents_data_deletion(self):
        result = self.run_reset("--yes", env=dict(self.env, RESET_TEST_STOP_FAIL="1"))
        self.assertEqual(result.returncode, 23)
        self.assertTrue(all((self.root / "volumes" / name / "data").exists() for name in self.state_volumes))
        self.assertFalse(any(a[0] == "run" for a in self.commands()))

    def test_running_container_prevents_data_deletion(self):
        result = self.run_reset("--yes", env=dict(self.env, RESET_TEST_STILL_RUNNING="1"))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(a[0] == "run" for a in self.commands()))

    def test_clear_failure_is_not_reported_as_success(self):
        result = self.run_reset("--yes", env=dict(self.env, RESET_TEST_CLEAR_FAIL="1"))
        self.assertEqual(result.returncode, 24)
        self.assertNotIn("state cleared", result.stdout)

    def test_reset_preserves_resources_sources_and_caches_and_can_repeat(self):
        result = self.run_reset("--yes")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(all((self.root / name).exists() for name in self.keep))
        for name in self.state_volumes:
            self.assertTrue((self.root / "volumes" / name).is_dir())
            self.assertFalse((self.root / "volumes" / name / "data").exists())
        self.assertTrue((self.root / "volumes/gradle-cache/data").exists())
        commands = self.commands()
        self.assertIn(["stop", "canton-dex-backend-1"], commands)
        for args in commands:
            if "--filter" in args:
                self.assertEqual(args[args.index("--filter") + 1], "label=com.docker.compose.project=canton-dex")
        helpers = [a for a in commands if a[0] == "run"]
        self.assertEqual(len(helpers), 3)
        self.assertTrue(all(a[a.index("--network") + 1] == "none" for a in helpers))
        self.assertFalse(any(a[0] in ("compose", "rm") or "prune" in a or a[:2] == ["volume", "rm"] for a in commands))
        self.assertEqual(self.run_reset("--yes").returncode, 0)
        self.assertEqual(sum(a[0] == "stop" for a in self.commands()), 1)


if __name__ == "__main__":
    unittest.main()
