FROM oven/bun:1

WORKDIR /app

# Copy dependency definitions
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Run the bot
CMD ["bun", "run", "src/index.ts"]