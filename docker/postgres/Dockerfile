# Postgres 17 + pgvector, with our init scripts baked in (not bind-mounted: the shared `oat` stack must not
# depend on the git worktree that happened to start it).
FROM pgvector/pgvector:0.8.7-pg17
COPY init/ /docker-entrypoint-initdb.d/
