# Commetty Book — ~8 MB image, runs as non-root, data in /data.
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /commetty . && mkdir /data

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /commetty /commetty
COPY --from=build --chown=65534:65534 /data /data
USER 65534:65534
ENV DATA_DIR=/data PORT=8080
EXPOSE 8080
VOLUME /data
ENTRYPOINT ["/commetty"]
