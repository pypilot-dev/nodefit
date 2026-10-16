# Changelog

## 0.1.0

First release.

- Bundles the nodefit language server; nothing else to install.
- Diagnostics, hovers and quick fixes on `package.json` dependencies whose
  `engines.node` or prebuilt native binaries rule out the Node you run.
- Status bar item with the Node release the project fits, and the report one
  click away.
- Notifications for new problems with buttons that pin or switch Node.
- Commands: Show Report, Check a Package, Pin Node Version, Re-check the
  Project, Show Output.
- Settings: `nodefit.notifications`, `nodefit.includeDevDependencies`,
  `nodefit.trace.server`.
