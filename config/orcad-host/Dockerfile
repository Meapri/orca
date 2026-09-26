# orcad in a container, built from a verified release tarball (no Electron, Xvfb or GTK).
#
# From the repository root, after `node config/scripts/pack-orcad-release.mjs --target linux-x64-glibc`:
#   docker build -f config/orcad-host/Dockerfile \
#     --build-arg ORCAD_TARBALL=out/orcad-release/orcad-<version>-linux-x64-glibc.tar.gz -t orcad .
#   docker run -d --name orcad -p 127.0.0.1:6768:6768 -v orcad-data:/home/orca/.orca orcad
#
# Daemon-scope caveat: a container has no systemd user manager, so the terminal daemon cannot
# get its own orca-daemon-*.scope (health.terminalDaemon.cgroupUnit is null). `supervise`
# restarts a crashed orcad beside the still-running daemon, which then re-adopts every PTY,
# but `docker stop`/`restart` ends the PID namespace and every terminal with it. Treat any
# container stop as destructive and apply the census rule in docs/reference/orcad-operations.md.
ARG BASE_IMAGE=debian:bookworm-slim

FROM ${BASE_IMAGE} AS base
ENV DEBIAN_FRONTEND=noninteractive
# tini is PID 1 so exited PTY children are reaped instead of accumulating as zombies.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client procps tini \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/bash orca
COPY config/orcad-host/orcad-install.sh /usr/local/bin/orcad-install

FROM base AS install
ARG ORCAD_TARBALL
COPY --chown=orca:orca ${ORCAD_TARBALL} ${ORCAD_TARBALL}.sha256 /tmp/orcad-release/
USER orca
# The checksum beside the tarball is verified before anything is extracted.
RUN ORCAD_SERVICE=none orcad-install upgrade "/tmp/orcad-release/$(basename "${ORCAD_TARBALL}")"

FROM base
COPY --from=install --chown=orca:orca /home/orca/.orca-remote /home/orca/.orca-remote
USER orca
WORKDIR /home/orca
# Inside the container's own network namespace; publish the port on the host's loopback
# (-p 127.0.0.1:6768:6768) and reach it over an SSH forward or Tailscale, never 0.0.0.0.
ENV ORCAD_SERVICE=none \
    ORCAD_BIND=0.0.0.0 \
    ORCAD_PORT=6768
VOLUME ["/home/orca/.orca"]
EXPOSE 6768
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/orcad-install", "supervise"]
