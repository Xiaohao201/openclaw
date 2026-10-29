Reliable Stop output source patches

1. Back up both deployments. Review STOP-OUTPUT-DEPLOYMENT.md.
2. In each matching repository, run git apply --check <corresponding.patch>.
3. If the check passes, run git apply <corresponding.patch>.
4. Apply the SQL migration to the history writer database BEFORE starting the updated frontend.
5. Build and restart both services as described in the deployment guide.

Do not apply over unrelated local modifications without reviewing conflicts.
These patches contain source and tests, not dependencies, credentials or runtime configuration.
Remote deployment and live fault injection have not been performed.
