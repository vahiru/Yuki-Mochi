FROM debian:bookworm-slim AS builder

ENV DEBIAN_FRONTEND=noninteractive
ENV BUN_INSTALL=/root/.bun
ENV PATH=/root/.bun/bin:/root/.cargo/bin:${PATH}
ARG APT_MIRROR=https://deb.debian.org/debian

RUN set -eux; \
    rm -f /etc/apt/sources.list.d/debian.sources; \
    printf '%s\n' \
      "deb ${APT_MIRROR} bookworm main contrib non-free non-free-firmware" \
      "deb ${APT_MIRROR} bookworm-updates main contrib non-free non-free-firmware" \
      "deb ${APT_MIRROR}-security bookworm-security main contrib non-free non-free-firmware" \
      > /etc/apt/sources.list; \
    apt-get -o Acquire::Retries=5 update; \
    apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      build-essential \
      pkg-config \
      libssl-dev \
      libprotobuf-dev \
      protobuf-compiler \
      python3 \
      make \
      g++ \
      unzip \
      docker.io; \
    rm -rf /var/lib/apt/lists/*

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG BUN_VERSION=1.2.5
RUN set -euo pipefail \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/root/.bun bash -s "bun-v${BUN_VERSION}" \
    && /root/.bun/bin/bun --version \
    && ln -sf /root/.bun/bin/bun /usr/local/bin/bun \
    && /root/.bun/bin/bun install -g node-gyp typescript

ARG RUST_VERSION=1.82.0
RUN set -euo pipefail \
    && curl -fsSL https://sh.rustup.rs | bash -s -- -y --profile minimal --default-toolchain "${RUST_VERSION}" \
    && /root/.cargo/bin/rustc --version

FROM debian:bookworm-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive
ARG APT_MIRROR=https://deb.debian.org/debian

RUN set -eux; \
    rm -f /etc/apt/sources.list.d/debian.sources; \
    printf '%s\n' \
      "deb ${APT_MIRROR} bookworm main contrib non-free non-free-firmware" \
      "deb ${APT_MIRROR} bookworm-updates main contrib non-free non-free-firmware" \
      "deb ${APT_MIRROR}-security bookworm-security main contrib non-free non-free-firmware" \
      > /etc/apt/sources.list; \
    apt-get -o Acquire::Retries=5 update; \
    apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      libssl3 \
      libprotobuf32 \
      python3 \
      unzip \
      docker.io; \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /root/.bun /root/.bun
COPY --from=builder /root/.cargo /root/.cargo

ENV BUN_INSTALL=/root/.bun
ENV PATH=/root/.bun/bin:/root/.cargo/bin:${PATH}

RUN useradd -m -s /bin/bash kairos

WORKDIR /workspace

CMD ["bash"]
