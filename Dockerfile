FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

# Instala dependências do Node
COPY package.json .
RUN npm install

# Copia o código
COPY . .

# Usa o Chromium que já vem instalado na imagem oficial do Playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 3000

CMD ["node", "index.js"]
