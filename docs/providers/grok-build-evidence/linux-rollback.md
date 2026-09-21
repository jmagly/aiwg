# Linux refresh failure and backup recovery

This is a disposable-project recovery check for the pinned Grok Build 1.0.38
Linux binary. AIWG ran from signed source commit
`6cf8018bafba18d8c15e362c374beef0c3730394`. The project and Grok home were
isolated under `/tmp`; the project was explicitly trusted in that isolated Grok
home. No credential or model call was used.

The project already had the `sdlc` bundle deployed for `grok-build`. Before
injecting a failure, `aiwg build-verify --provider grok-build` returned
`status: ready`. A copy preserving file types and metadata (`cp -a`) captured
the healthy project preimage. The fixture then moved one managed native skill
directory to a sibling outside the project and replaced its project path with a
symlink to that outside directory. The outside directory contained a sentinel
file whose SHA-256 was recorded before the refresh.

With the pinned binary on `PATH`, the command
`aiwg refresh --skip-update --provider grok-build --frameworks sdlc` exited 1
and reported `Deploy issue: sdlc (exit 1)`. The outside sentinel hash was
unchanged. The failed project tree was moved aside, and the preimage backup was
copied back to the original project path. `diff -qr` between backup and restored
project produced no differences (exit 0), and build verification again returned
`status: ready` (exit 0). A control refresh on the restored, healthy project
exited 0 and reported `Deployed: sdlc` and `Refresh complete`.

This proves that the documented **operator backup/restore recovery path** can
restore the exact project preimage after a controlled refresh failure, while
the linked outside target is left alone. It does not claim that AIWG
automatically rolls back a partially applied refresh, or qualify credentialed
native behavior. The controlled link was deliberately introduced after the
healthy backup, so the restored project has the ordinary managed skill directory.
