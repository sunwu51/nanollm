# Deploy and Host nanollm on Railway

A lightweight LLM gateway with OpenAI Chat Completions, Responses, Anthropic Messages, and OpenAI image API support. Manage providers, models, and fallback groups in a browser.

## About Hosting nanollm

This template runs two Docker services in US West: nanollm and a private quicSQL database named sqld. Node.js and the Rust OAuth transport helper are built into the gateway image. Each service has its own persistent volume.

## Why Deploy nanollm on Railway?

- Builds directly from the public nanollm repository using its Dockerfile.
- Generates a unique `NANOLLM_AUTH_TOKEN` for each deployment.
- Provisions `/data` for gateway configuration and subscription credentials, and `/var/lib/sqld` for SQLite request records and statistics.
- Connects the gateway to quicSQL automatically over Railway private networking, with no database password or public database endpoint.
- Enables Serverless for sqld while keeping nanollm always running. After a quiet minute or a failed request, the gateway retries a read-only wake-up probe before its next HTTP database request; uncertain writes are not replayed. Reading records after inactivity may wait for a cold start.
- Creates the database automatically on a fresh volume. Both services build from the repository's `dev` branch; sqld watches only `/.railway/quicsql/**`.
- Sets the Node.js old-generation heap limit to 256 MiB by default.
- Enables a public Railway domain and checks `/health` before activating the deployment.
- Starts with an empty model list, ready to configure through `/admin`.

## Common Use Cases

- Aggregate multiple model providers behind one API endpoint.
- Configure model fallback groups and inspect request records in a browser.
- Use supported subscription providers through the gateway's admin login flow.

## Dependencies for nanollm

### Deployment Dependencies

A Railway account is needed to deploy this template. The template provisions two services, a gateway public domain, and two persistent volumes automatically. It generates a gateway access key and configures the private database URL without requiring user input. Both services incur Railway resource charges; the template does not guarantee a free deployment.

### After deploying

1. Copy `NANOLLM_AUTH_TOKEN` from the service's Variables tab.
2. Open `https://YOUR_DOMAIN/admin?token=YOUR_TOKEN`, replacing `YOUR_DOMAIN` and `YOUR_TOKEN` with your service domain and generated token.
3. Add your providers and models, then save.
4. Set your API client's base URL to `https://YOUR_DOMAIN/v1` and its API key to the generated token.

No Turso database or external API key is required to start the gateway. Configure upstream credentials or subscription login in the admin page when adding models.

Configuration and credentials persist across redeploys on the `/data` volume. To rotate the gateway key after initialization, update `server.auth.token` in the configuration and restart the service; changing the environment variable alone does not overwrite an existing configuration file.

[Project documentation](https://github.com/sunwu51/nanollm)
