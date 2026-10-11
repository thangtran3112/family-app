# syntax=docker/dockerfile:1.7
# TradingAgents private research API + static shell. "base" is the upstream
# image built unmodified from ai-trading/packages/trading-agents/Dockerfile;
# "web" is this wrapper's own package (ai-trading/tradingagents-web), copied
# in unmodified from its own named context (see docker-bake.hcl). Runs
# alongside the existing terminal image, on its own internal-only port, never
# sharing the terminal's data volume (see docker-compose.yml).
FROM base
USER root

# Hash-pinned, --no-deps wrapper additions on top of the upstream environment.
# Compare every installed distribution's version before and after: any change
# to an existing (upstream-pinned) package -- upgrade or downgrade -- fails
# the build, so these additions can never silently drift the locked upstream
# environment. pip check then confirms the combined environment still has no
# unmet/conflicting requirements.
COPY --from=web requirements.lock /tmp/ta-web-requirements.lock
RUN python3 -m pip freeze --all >/tmp/before-install.txt \
 && pip install --no-cache-dir --no-deps --require-hashes -r /tmp/ta-web-requirements.lock \
 && python3 -m pip freeze --all >/tmp/after-install.txt \
 && python3 -c "import sys; vers = lambda p: dict(l.strip().split('==', 1) for l in open(p) if '==' in l); b, a = vers('/tmp/before-install.txt'), vers('/tmp/after-install.txt'); changed = sorted(n for n, v in b.items() if a.get(n) != v); sys.exit('web.Dockerfile: upstream-pinned package(s) changed version: ' + ', '.join(changed)) if changed else None" \
 && pip check \
 && rm -f /tmp/ta-web-requirements.lock /tmp/before-install.txt /tmp/after-install.txt

# Wrapper package/static assets and its DIVERGENCE manifest, copied in
# unmodified from the web context. The manifest is also kept at this upstream
# manifest location, next to upstream's own files, so it is visible from the
# same directory the `tradingagents` CLI itself runs from.
COPY --from=web ta_web /home/appuser/app/ta_web
COPY --from=web DIVERGENCE.md /home/appuser/app/DIVERGENCE.md

USER appuser
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
EXPOSE 8182
# One explicit Uvicorn worker, no autoreload, no access log, no Server
# header: this is an internal-only service reached only through the trusted
# Caddy gateway on its own dedicated "research" network (never published,
# never sharing a network with ta-terminal -- see docker-compose.yml). The
# base image's own ENTRYPOINT ["tradingagents"]
# (ai-trading/packages/trading-agents/Dockerfile) must be cleared here --
# otherwise CMD's argv is passed as arguments *to* that CLI instead of
# replacing it ("No such command 'uvicorn'").
#
# --forwarded-allow-ips is deliberately NOT set here (would default to "*"
# if passed with no value, or require a value baked into the image either
# way): review round 1 (Critical) requires the trusted peer to be scoped to
# the actual deployed network, which only docker-compose.yml knows. Uvicorn
# itself falls back to the $FORWARDED_ALLOW_IPS environment variable when
# the flag is omitted (https://www.uvicorn.org/settings/#http) -- production
# sets it to the dedicated "research" network's own fixed subnet; omitting
# it entirely (e.g. a bare `docker run`, as in this task's own image test)
# falls back to Uvicorn's own default (loopback only), never "*".
ENTRYPOINT []
CMD ["uvicorn", "ta_web.app:application", "--host", "0.0.0.0", "--port", "8182", \
     "--workers", "1", "--no-access-log", "--no-server-header", "--proxy-headers"]
