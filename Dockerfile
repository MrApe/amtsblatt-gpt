FROM node:alpine

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium-browser"

RUN apk update && apk upgrade && \
    apk add --no-cache \
      udev \
      ttf-freefont \
      ca-certificates \
      chromium \
      nss \
      freetype \
      harfbuzz

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --verbose
COPY index.js .

CMD [ "node", "index.js" ]