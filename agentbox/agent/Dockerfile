ARG BASE_IMAGE=debian:bookworm-slim
FROM ghcr.io/astral-sh/uv:0.12.15 AS uv

FROM ${BASE_IMAGE}
USER root

ARG APT_PACKAGES=""
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash build-essential ca-certificates curl git jq less procps python3 python3-venv \
      ripgrep unzip ${APT_PACKAGES} \
    && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /uvx /usr/local/bin/

ENV MISE_DATA_DIR=/opt/mise \
    MISE_GLOBAL_CONFIG_FILE=/etc/mise/config.toml \
    PATH=/opt/mise/shims:$PATH
RUN curl -fsSL https://mise.run \
    | MISE_VERSION=v2026.9.10 MISE_INSTALL_PATH=/usr/local/bin/mise sh
ARG TOOLS=""
RUN mkdir -p /etc/mise /opt/mise && if [ -n "$TOOLS" ]; then mise use --global $TOOLS; fi

ARG KEYWORK_VERSION
RUN curl -fsSL https://raw.githubusercontent.com/JMoak/keywork/main/scripts/install.sh \
    | KEYWORK_VERSION=${KEYWORK_VERSION} KEYWORK_INSTALL_DIR=/usr/local/bin sh \
    && ln -s /usr/local/bin/keywork /usr/local/bin/harness

COPY --chmod=755 entrypoint.sh /usr/local/bin/agentbox-entrypoint
COPY --chmod=755 check.sh /usr/local/bin/agentbox-check
COPY keywork.json house-rules.md /etc/agentbox/

ARG HOST_UID=1000
ARG HOST_GID=1000
RUN groupadd --non-unique --gid "$HOST_GID" dev \
    && useradd --non-unique --create-home --uid "$HOST_UID" --gid "$HOST_GID" --shell /bin/bash dev \
    && install -d -o dev -g dev /workspace /workspace/node_modules /workspace/.venv \
    && chown -R dev:dev /opt/mise
USER dev
ENV HOME=/home/dev

WORKDIR /workspace
ENTRYPOINT ["agentbox-entrypoint"]
CMD ["sleep", "infinity"]
