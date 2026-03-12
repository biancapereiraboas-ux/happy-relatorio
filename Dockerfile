FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

# Instala dependências do Node
COPY package.json .
RUN npm install

# Copia o código
COPY . .

# Usa o Chromium do sistema operacional (já vem na imagem do Playwright)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

EXPOSE 3000

CMD ["node", "index.js"]
