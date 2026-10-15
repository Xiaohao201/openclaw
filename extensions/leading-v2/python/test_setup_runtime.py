import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from setup_runtime import install_runtime, main, python_in_environment


class SetupRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = Path(self.temp.name) / "plugin" / "python"
        self.runtime.mkdir(parents=True)
        for name in ("runner.py", "browser_setup.py", "requirements.txt"):
            (self.runtime / name).write_text("fixture", encoding="utf-8")

    def create_environment(self, path):
        python = python_in_environment(path)
        python.parent.mkdir(parents=True)
        python.write_text("fixture", encoding="utf-8")
        (path / "pyvenv.cfg").write_text("fixture", encoding="utf-8")

    def test_installs_pinned_requirements_and_checks_driver_without_installing_a_browser(self):
        with patch("setup_runtime.venv.EnvBuilder") as builder, patch("setup_runtime.subprocess.run") as run:
            builder.return_value.create.side_effect = self.create_environment
            python = install_runtime(self.runtime)
        builder.assert_called_once_with(with_pip=True)
        self.assertEqual(python, python_in_environment(self.runtime.parent / ".venv"))
        calls = [call.args[0] for call in run.call_args_list]
        self.assertEqual(calls, [
            [str(python), "-m", "pip", "install", "--disable-pip-version-check", "-r", str(self.runtime / "requirements.txt")],
            [str(python), str(self.runtime / "runner.py"), "--check-runtime"],
        ])
        self.assertTrue(all(call.kwargs["check"] for call in run.call_args_list))

    def test_reuses_installed_environment_and_propagates_failed_setup(self):
        import subprocess
        self.create_environment(self.runtime.parent / ".venv")
        with patch("setup_runtime.venv.EnvBuilder") as builder, \
                patch("setup_runtime.subprocess.run", side_effect=subprocess.CalledProcessError(1, "pip")):
            with self.assertRaises(subprocess.CalledProcessError):
                install_runtime(self.runtime)
        builder.assert_not_called()

    def test_incomplete_runtime_or_foreign_environment_is_not_overwritten(self):
        with patch("setup_runtime.venv.EnvBuilder") as builder, patch("setup_runtime.subprocess.run") as run:
            with self.assertRaises(ValueError):
                install_runtime(self.runtime / "missing")
            (self.runtime.parent / ".venv").mkdir()
            with self.assertRaises(ValueError):
                install_runtime(self.runtime)
        builder.assert_not_called()
        run.assert_not_called()

    def test_unsupported_python_does_not_create_an_environment(self):
        with patch("setup_runtime.sys.version_info", (3, 9)), \
                patch("setup_runtime.venv.EnvBuilder") as builder:
            with self.assertRaisesRegex(ValueError, "3.10"):
                install_runtime(self.runtime)
        builder.assert_not_called()

    def test_cli_returns_nonzero_after_install_failure(self):
        with patch("setup_runtime.sys.argv", ["setup_runtime.py", "--runtime-dir", str(self.runtime)]), \
                patch("setup_runtime.install_runtime", side_effect=OSError("fixture failure")) as install, \
                patch("setup_runtime.sys.stderr", new_callable=io.StringIO) as error:
            self.assertEqual(main(), 1)
        install.assert_called_once_with(self.runtime)
        self.assertIn("Setup failed", error.getvalue())

    def test_cli_reports_ready_only_after_successful_install(self):
        python = python_in_environment(self.runtime.parent / ".venv")
        with patch("setup_runtime.sys.argv", ["setup_runtime.py", "--runtime-dir", str(self.runtime)]), \
                patch("setup_runtime.install_runtime", return_value=python), \
                patch("setup_runtime.sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(main(), 0)
        self.assertIn(str(python), output.getvalue())


if __name__ == "__main__":
    unittest.main()
