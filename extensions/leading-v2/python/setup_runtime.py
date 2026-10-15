"""Install and verify the plugin's Python environment; never install or open Chrome."""
import argparse
from pathlib import Path
import subprocess
import sys
import venv


def python_in_environment(environment):
    return Path(environment) / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")


def install_runtime(runtime):
    runtime = Path(runtime).resolve()
    if sys.version_info < (3, 10):
        raise ValueError("Python 3.10 or newer is required")
    if not all((runtime / name).is_file() for name in ("runner.py", "browser_setup.py", "requirements.txt")):
        raise ValueError("Incomplete Python runtime; stage the complete plugin first")
    environment = runtime.parent / ".venv"
    python = python_in_environment(environment)
    if environment.exists() and (not python.is_file() or not (environment / "pyvenv.cfg").is_file()):
        raise ValueError("Existing .venv is incomplete; inspect it before rebuilding the environment")
    if not environment.exists():
        venv.EnvBuilder(with_pip=True).create(environment)
    (environment / ".gitignore").write_text("*\n", encoding="utf-8")
    subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check",
                    "-r", str(runtime / "requirements.txt")], check=True)
    subprocess.run([str(python), str(runtime / "runner.py"), "--check-runtime"], check=True)
    return python


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-dir", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    try:
        python = install_runtime(args.runtime_dir)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"[complaint-runtime] Setup failed: {error}", file=sys.stderr)
        return 1
    print(f"[complaint-runtime] Ready: {python}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
