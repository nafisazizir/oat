# mock-oauth2-server with our issuer config + offline login page baked in (not bind-mounted: the shared
# `oat` stack must not depend on the git worktree that happened to start it).
FROM ghcr.io/navikt/mock-oauth2-server:7.0.0
COPY config.json login.html /config/
ENV SERVER_PORT=8080 \
    JSON_CONFIG_PATH=/config/config.json
