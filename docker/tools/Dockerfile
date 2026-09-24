# Daml SDK tools for building and testing the contracts. DPM needs a JDK; no application
# code runs in this image.
FROM eclipse-temurin:21-jdk-jammy
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip libgmp10 make \
    && rm -rf /var/lib/apt/lists/*
ARG DPM_VERSION=3.5.7
RUN curl -fsSL https://get.digitalasset.com/install/install.sh -o /tmp/install-dpm.sh \
    && TERM=xterm sh /tmp/install-dpm.sh "$DPM_VERSION" \
    && rm /tmp/install-dpm.sh
ENV PATH="/root/.dpm/bin:${PATH}"
COPY --chmod=755 build-contracts.sh /usr/local/bin/build-contracts
WORKDIR /workspace
