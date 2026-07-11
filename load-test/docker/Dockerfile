# k6本体は公式イメージからバイナリのみ拝借する（grafana/k6はscratchベースでshell/aws-cliを持たないため）
FROM grafana/k6:1.3.0 AS k6

FROM alpine:3.22
RUN apk add --no-cache aws-cli curl jq bash

COPY --from=k6 /usr/bin/k6 /usr/bin/k6
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /work
ENTRYPOINT ["/entrypoint.sh"]
