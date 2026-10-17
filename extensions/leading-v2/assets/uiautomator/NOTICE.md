# Android automation server

`u2.jar` is the Android server distributed in the pinned `uiautomator2` 3.7.0
wheel. The plugin calls its JSON-RPC protocol directly from TypeScript and does
not import or execute the Python package. The MIT license is included alongside
this notice.

- Upstream: https://github.com/openatx/uiautomator2/tree/3.7.0
- Source wheel: https://files.pythonhosted.org/packages/55/23/a5f93de8bb197ae2d2d0185c2c13d4b36ae7f18215e3e599e217f8e90e0d/uiautomator2-3.7.0-py3-none-any.whl
- Wheel SHA-256: `731bf4e26e35cd440cd165b399b8a4d4b795178d78b9243769e336aee6dce985`
- JAR SHA-256: `0b74e83c55f443539a9f76f5ce023a51466b764b1100e4097a897053fdfc0eb6`

The runtime verifies the JAR checksum before pushing it to an explicitly bound
Android device. It does not install an APK or switch the user's keyboard.
