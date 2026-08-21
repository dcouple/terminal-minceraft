FROM eclipse-temurin:21-jre-alpine

RUN apk add --no-cache bash curl nodejs npm

WORKDIR /srv/eaglercraft

COPY config/server.properties server.properties
COPY config/spigot.yml spigot.yml
COPY config/bungee/ bungee/
COPY config/eaglercraft_opts.js bungee/eaglercraft_opts.js
COPY config/server-run.sh server-run.sh
COPY config/bungee-run.sh bungee-run.sh
COPY docker/entrypoint.sh /entrypoint.sh

RUN chmod +x server-run.sh bungee-run.sh /entrypoint.sh

RUN echo "eula=true" > eula.txt

EXPOSE 5200

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=90s \
  CMD curl -f http://localhost:5200/ || exit 1

ENTRYPOINT ["/entrypoint.sh"]
