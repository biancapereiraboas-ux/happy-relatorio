FROM node:18-slim

WORKDIR /app

# Instala Chromium como pacote do sistema operacional
RUN apt-get update && apt-get install -y chromium --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Instala dependências do Node
COPY package.json .
RUN npm install

# Copia o código
COPY . .

# Aponta para o Chromium do sistema (não baixa um novo)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 3000

CMD ["node", "index.js"]
