FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends tinyproxy \
    && rm -rf /var/lib/apt/lists/*

COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY --chmod=755 start.sh /usr/local/bin/gate

USER tinyproxy
EXPOSE 3128
ENTRYPOINT ["gate"]
